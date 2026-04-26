// `hivectl credential revoke <jti> [--reason <text>] [--yes]`

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { parseUuidV7 } from '#input/parse-uuid.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import type { GlobalCliOpts } from '#types.js';

export interface RevokeCredentialOpts {
  globals: GlobalCliOpts;
  jti: string;
  reason: string | undefined;
}

export interface RevokeCredentialResult {
  revokedJti: UUIDv7;
}

export async function runRevokeCredential(
  runtime: CliRuntime,
  opts: RevokeCredentialOpts,
): Promise<RevokeCredentialResult> {
  if (!opts.globals.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: 'credential revoke is destructive; pass --yes to confirm',
    });
  }
  const jti = parseUuidV7(opts.jti, 'jti');
  const actor = await buildOperatorActor(opts.globals, runtime);

  const revokeInput: Parameters<typeof runtime.revoker.revokeCredential>[0] = { jti };
  if (actor.actorId !== null) revokeInput.revokedBy = actor.actorId;
  if (opts.reason !== undefined && opts.reason !== '') revokeInput.reason = opts.reason;

  await runtime.revoker.revokeCredential(revokeInput);

  const detail: Record<string, unknown> = { ...actor.detail };
  if (opts.reason !== undefined && opts.reason !== '') detail['reason'] = opts.reason;
  await runtime.auditRecorder.recordEvent({
    category: 'admin_credential_revoke',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: jti,
    subjectKind: 'credential',
    reasonCode: null,
    detail,
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  return { revokedJti: jti };
}
