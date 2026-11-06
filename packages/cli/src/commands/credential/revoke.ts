// `hivectl credential revoke <jti-or-active-ref> [--reason <text>] [--revoke-agents] [--yes]`
//
// `<jti-or-active-ref>` accepts either a UUID v7 JTI (canonical) or a
// `<participant-ref>:latest` alias resolving to that participant's currently-
// active credential — per ADR-020 Q3=3B + PRY-041 of the cascade.
//
// ADR-026: revoking an enrollment credential also blocklists every Worker token issued
// through it; `--revoke-agents` additionally revokes its Agents, each with its own
// `admin_agent_revoke` audit row. `--revoke-agents` on any other credential is a user
// error raised by the domain.

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { resolveCredentialRef } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import { isEnrollmentCredential } from './rotate.js';
import type { GlobalCliOpts } from '#types.js';

export interface RevokeCredentialOpts {
  globals: GlobalCliOpts;
  jti: string;
  reason: string | undefined;
  revokeAgents?: boolean;
}

export interface RevokeCredentialResult {
  revokedJti: UUIDv7;
  revokedTokens: number;
  revokedAgentIds: UUIDv7[];
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
  const jti = await resolveCredentialRef(opts.jti, runtime);
  const actor = await buildOperatorActor(opts.globals, runtime);
  const isEnrollment = await isEnrollmentCredential(runtime, jti);

  const revokeInput: Parameters<typeof runtime.revoker.revokeCredential>[0] = { jti };
  if (actor.actorId !== null) revokeInput.revokedBy = actor.actorId;
  if (opts.reason !== undefined && opts.reason !== '') revokeInput.reason = opts.reason;
  if (opts.revokeAgents === true) revokeInput.revokeAgents = true;

  const { revokedTokenJtis, revokedAgentIds } = await runtime.revoker.revokeCredential(revokeInput);

  const detail: Record<string, unknown> = { ...actor.detail };
  if (opts.reason !== undefined && opts.reason !== '') detail['reason'] = opts.reason;
  if (isEnrollment) {
    detail['revokedAgents'] = opts.revokeAgents === true;
    detail['revokedTokens'] = revokedTokenJtis.length;
  }
  await runtime.auditRecorder.recordEvent({
    category: isEnrollment ? 'enrollment_credential_revoked' : 'admin_credential_revoke',
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

  for (const agentId of revokedAgentIds) {
    await runtime.auditRecorder.recordEvent({
      category: 'admin_agent_revoke',
      decision: 'success',
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      subjectId: agentId,
      subjectKind: 'participant',
      reasonCode: 'enrollment_credential_revoked',
      detail: { ...actor.detail, enrolledVia: jti },
      hiveId: runtime.hiveStableIdentifier,
      occurredAt: new Date(),
      requestId: null,
    });
  }

  return { revokedJti: jti, revokedTokens: revokedTokenJtis.length, revokedAgentIds };
}
