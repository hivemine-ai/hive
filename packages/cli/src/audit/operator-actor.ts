// Build the actor metadata for an audit_log row from CLI globals.
// Per the tech spec rationale: audit events emitted by hivectl default
// to actorKind: 'system'.
//
// Per ADR-020: `--operator-id` accepts UUID v7 OR Hivekeeper email. The raw
// input flows from globals; we resolve it here via `resolveOperatorId` (which
// uses the shared parser + repo lookup) before the active-admin validation.

import { isAuthError } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '../error/cli-error.js';
import { resolveOperatorId } from '../input/parse-reference.js';
import type { GlobalCliOpts, OperatorActor } from '../types.js';

export const OPERATOR_NOTE_MAX_LENGTH = parseInt(
  process.env['HIVE_CLI_AUDIT_OPERATOR_NOTE_MAX_LENGTH'] ?? '256',
  10,
);

const CLI_VERSION = '0.1.0-dev';

/**
 * Resolve the OperatorActor for the current command. Validates that
 * `--operator-id`, when provided, references an active admin Hivekeeper.
 * Anchors the audit log entry to the CLI process via cli version + osUser.
 */
export async function buildOperatorActor(
  opts: GlobalCliOpts,
  runtime: CliRuntime,
): Promise<OperatorActor> {
  const detail: Record<string, unknown> = { cliVersion: CLI_VERSION };

  if (opts.operatorNote !== undefined) {
    detail['operatorNote'] = truncate(opts.operatorNote, OPERATOR_NOTE_MAX_LENGTH);
  }
  const osUser = process.env['USER'];
  if (osUser !== undefined && osUser !== '') {
    detail['osUser'] = osUser;
  }

  if (opts.operatorId !== undefined) {
    const operatorUuid = await resolveOperatorIdSafely(opts.operatorId, runtime);
    const operatorHk = await runtime.participantsRepo.findHivekeeperById(operatorUuid);
    if (!operatorHk) {
      throw new CliError('OPERATOR_ID_NOT_ADMIN', { subCode: 'not_found' });
    }
    if (operatorHk.state !== 'active') {
      throw new CliError('OPERATOR_ID_NOT_ADMIN', { subCode: 'not_active' });
    }
    if (!operatorHk.isAdmin) {
      throw new CliError('OPERATOR_ID_NOT_ADMIN', { subCode: 'not_admin' });
    }
    return { actorId: operatorHk.id, actorKind: 'hivekeeper', detail };
  }

  return { actorId: null, actorKind: 'system', detail };
}

/**
 * Resolve --operator-id input to a UUIDv7. Maps `AuthError(PARTICIPANT_NOT_FOUND)`
 * thrown by the resolver (email shape that did not resolve) to the existing
 * `OPERATOR_ID_NOT_ADMIN(not_found)` subCode so handler.ts produces the same
 * EXIT_PERMISSION exit + message the operator is used to. Other CLI errors
 * (malformed reference, kind not allowed) bubble unchanged.
 */
async function resolveOperatorIdSafely(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  try {
    return await resolveOperatorId(input, runtime);
  } catch (err) {
    if (isAuthError(err) && err.code === 'PARTICIPANT_NOT_FOUND') {
      throw new CliError('OPERATOR_ID_NOT_ADMIN', { subCode: 'not_found' });
    }
    throw err;
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + '…';
}
