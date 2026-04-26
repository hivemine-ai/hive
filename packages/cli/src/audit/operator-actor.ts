// Build the actor metadata for an audit_log row from CLI globals.
// Per the tech spec § "Decisión: audit events emitidos por hivectl con
// actorKind: 'system' por default".

import type { CliRuntime } from '@hive/server';

import { CliError } from '../error/cli-error.js';
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
    const operatorHk = await runtime.participantsRepo.findHivekeeperById(opts.operatorId);
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

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + '…';
}
