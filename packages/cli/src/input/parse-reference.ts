// Resolve a participant reference to a canonical UUIDv7 — CLI side.
//
// Per ADR-020, the parser itself lives in `@hive/server`'s
// `domain/auth/references/parser.ts` (single source of truth shared with the
// MCP wire). The CLI layer wraps it with the caller context loaded from the
// runtime + repo lookups + uniform error mapping.
//
// `--operator-id` (resolveOperatorId): UUID OR Hivekeeper email. 'self' /
// agent-reference are not applicable (operators are always Hivekeepers per
// ADR-007).
//
// `--owner` / `--participant-id` / `<participant-ref>` (resolveParticipantReference):
// UUID OR Hivekeeper email today. Credential-active alias will be wired in
// PRY-041 of the cascade.
//
// `<agent-ref>` positional in `agent revoke` (resolveAgentReference, PRY-040):
// UUID OR agent-reference syntax (`<name>@<owner-local>.<hive>`). Email and
// 'self' / 'credential-active' kinds are not applicable.

import { AuthError, parseReference, type ParsedReference } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { getCliCallerContext } from '../composition/caller-context.js';
import { CliError } from '../error/cli-error.js';

export type { ParsedReference };

export type ParticipantReferenceKind = 'uuid' | 'email';

export interface ParsedParticipantReference {
  kind: ParticipantReferenceKind;
  raw: string;
}

/**
 * Parse a participant reference accepted by `--owner` / `--participant-id` /
 * `<participant-ref>` (UUID OR Hivekeeper email). Delegates to the shared
 * `parseReference` and projects the result to the legacy 2-kind shape.
 *
 * `hiveName` is required by the shared parser to disambiguate agent-references
 * from emails. Callers in PRY-039 do not yet accept agent-references; the
 * parser still rejects them as `reference_unparseable` here so behavior is
 * preserved. PRY-041/042 will introduce wider-scoped helpers.
 */
export function parseParticipantReference(
  input: string,
  hiveName: string,
): ParsedParticipantReference {
  const parsed = parseReference(input, hiveName);
  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'reference_unparseable',
      message: `'${input}' is neither a UUID v7 nor a valid email`,
    });
  }
  if (parsed.kind === 'uuid') return { kind: 'uuid', raw: parsed.id };
  if (parsed.kind === 'hivekeeper-email') return { kind: 'email', raw: parsed.email };
  // 'self' or 'agent-reference' — out of scope for the legacy 2-kind callers.
  throw new CliError('CONFIG_INVALID', {
    subCode: 'reference_unparseable',
    message: `'${input}' is neither a UUID v7 nor a valid email`,
  });
}

/**
 * Resolve any of the supported reference forms (UUID OR Hivekeeper email) to
 * a canonical participantId. Email lookups search the Hivekeeper table only —
 * agents do not have email identities in v0.1.
 */
export async function resolveParticipantReference(
  input: string,
  runtime: CliRuntime,
): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const ref = parseParticipantReference(input, ctx.hiveName);
  if (ref.kind === 'uuid') return ref.raw;
  const keeper = await runtime.participantsRepo.findHivekeeperByEmail(ctx.hiveId, ref.raw);
  if (!keeper) {
    throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'email_not_found' });
  }
  return keeper.id;
}

/**
 * Resolve `--operator-id` input to a UUIDv7. Accepted: UUID v7 OR Hivekeeper
 * email. The 'self' alias and agent-reference syntax produce
 * `CliError(OPERATOR_ID_INVALID)` because operators are always Hivekeepers
 * (per ADR-007).
 *
 * The downstream `buildOperatorActor` validates that the resolved UUID is an
 * active admin — this helper only translates the user-facing input form to
 * the canonical id.
 */
export async function resolveOperatorId(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('OPERATOR_ID_INVALID', {
      subCode: 'malformed_reference',
      message: `'${input}' is not a valid reference (expected UUID v7 or hivekeeper email)`,
    });
  }

  if (parsed.kind === 'uuid') return parsed.id;

  if (parsed.kind === 'hivekeeper-email') {
    const hk = await runtime.participantsRepo.findHivekeeperByEmail(ctx.hiveId, parsed.email);
    if (hk === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'operator_email_not_found' });
    }
    return hk.id;
  }

  // 'self' or 'agent-reference' — not applicable to --operator-id (operators
  // are always Hivekeepers; self is an MCP wire concept that has no CLI shell
  // analog).
  throw new CliError('OPERATOR_ID_INVALID', {
    subCode: 'kind_not_allowed',
    message: `--operator-id requires UUID v7 or hivekeeper email, got '${parsed.kind}'`,
  });
}

/**
 * Resolve an agent reference input to a canonical agent UUIDv7. Accepted forms:
 *   - UUID v7 (passes through without DB lookup; preserves the pre-PRY-040
 *     idempotent semantics of `repo.revokeAgent` for unknown UUIDs).
 *   - Agent reference `<name>@<owner-local>.<hiveName>` (per ADR-015 syntax,
 *     PRY-024 wire-side). Resolves owner via `findHivekeeperByEmailLocalPart`,
 *     then agent via `findAgentByName(hiveId, ownerId, name)`.
 *
 * Other parser kinds ('hivekeeper-email', 'self') are rejected with
 * `CliError(CONFIG_INVALID, kind_not_allowed)` because the agent revoke
 * positional only accepts an Agent identifier.
 *
 * Resolution failures (owner local-part not found, or agent name not found
 * under that owner) raise `AuthError(PARTICIPANT_NOT_FOUND)` so the existing
 * handler.ts mapping produces `EXIT_NOT_FOUND (3)` per ADR-020 § Decision
 * step 4.
 */
export async function resolveAgentReference(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'agent_ref_unparseable',
      message: `'${input}' is not a valid reference (expected UUID v7 or agent reference '<name>@<owner-local>.${ctx.hiveName}')`,
    });
  }

  if (parsed.kind === 'uuid') return parsed.id;

  if (parsed.kind === 'agent-reference') {
    const owner = await runtime.participantsRepo.findHivekeeperByEmailLocalPart(
      ctx.hiveId,
      parsed.ownerLocal,
    );
    if (owner === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'agent_owner_not_found' });
    }
    const agent = await runtime.participantsRepo.findAgentByName(
      ctx.hiveId,
      owner.id,
      parsed.agentName,
    );
    if (agent === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'agent_name_not_found' });
    }
    return agent.id;
  }

  // 'hivekeeper-email' or 'self' — not applicable to <agent-ref> (agents are
  // not addressable by email; self has no CLI shell analog).
  throw new CliError('CONFIG_INVALID', {
    subCode: 'kind_not_allowed',
    message: `<agent-ref> requires UUID v7 or agent reference '<name>@<owner-local>.${ctx.hiveName}', got '${parsed.kind}'`,
  });
}
