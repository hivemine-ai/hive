// Composition root for the Visibility Engine — wires the real implementation
// from its dependencies. Used by production bootstraps (CLI init, future
// MCP server). Tests of Cell Store unit code keep using `stubVisibilityEngine`
// in `composition/stubs.ts`.

import type { Kysely } from 'kysely';

import { createParticipantsReadRepo } from '#domain/auth/index.js';
import { createAuditRepo, createAuditRecorder } from '#domain/audit/index.js';
import type { NewAuditEvent } from '#domain/audit/index.js';
import { createVisibilityEngine } from '#domain/visibility/index.js';
import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';

export interface VisibilityEngineFactoryOptions {
  /**
   * Optional override for the `auditCanSeeDenials` config. If omitted, the
   * engine reads `HIVE_VISIBILITY_AUDIT_CANSEE_DENIALS` env var (default false).
   */
  auditCanSeeDenials?: boolean;
}

export interface VisibilityEngineFactoryDeps {
  db: Kysely<Database>;
  logger: Logger;
  /**
   * Optional post-commit hook fired after each audit insert succeeds. Wired
   * by the production composition root (wire.ts) to refresh the status
   * snapshot per [[ADR-022]]. Tests omit and the recorder skips silently.
   */
  onAuditAfterRecord?: (event: NewAuditEvent) => void | Promise<void>;
}

/**
 * Builds the production Visibility Engine. Constructs:
 *   - `ParticipantsReadRepo` for recipient lookup,
 *   - `AuditRepo` + `AuditRecorder` for non-transactional best-effort audit
 *     writes,
 *   - `VisibilityEngine` instance bound to those deps.
 *
 * The composition root MUST use this factory — never inject the
 * `stubVisibilityEngine` outside of unit tests.
 */
export function createVisibilityEngineForProduction(
  deps: VisibilityEngineFactoryDeps,
  options: VisibilityEngineFactoryOptions = {},
): VisibilityEngine {
  const participantsRepo = createParticipantsReadRepo(deps.db);
  const auditRepo = createAuditRepo(deps.db);
  const recorderDeps: Parameters<typeof createAuditRecorder>[0] = {
    auditRepo,
    logger: deps.logger,
  };
  if (deps.onAuditAfterRecord !== undefined) {
    recorderDeps.onAfterRecord = deps.onAuditAfterRecord;
  }
  const recorder = createAuditRecorder(recorderDeps);
  const config: { auditCanSeeDenials?: boolean } = {};
  if (options.auditCanSeeDenials !== undefined) {
    config.auditCanSeeDenials = options.auditCanSeeDenials;
  }
  return createVisibilityEngine({ participantsRepo, recorder, logger: deps.logger }, config);
}
