// `hivectl agent revoke <agent-id> [--yes]` — revoke an agent and cascade-close
// its Cell via the cells hook (cross-domain TX, wired in PRY-002).

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { parseUuidV7 } from '#input/parse-uuid.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import { toCallerContext } from '../hivekeeper/create.js';
import type { GlobalCliOpts } from '#types.js';

export interface RevokeAgentOpts {
  globals: GlobalCliOpts;
  agentRef: string;
}

export interface RevokeAgentResult {
  revokedAgentId: UUIDv7;
}

export async function runRevokeAgent(
  runtime: CliRuntime,
  opts: RevokeAgentOpts,
): Promise<RevokeAgentResult> {
  if (!opts.globals.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: 'agent revoke is destructive; pass --yes to confirm',
    });
  }
  const agentId = parseUuidV7(opts.agentRef, 'agent-id');
  const actor = await buildOperatorActor(opts.globals, runtime);
  const caller = toCallerContext(actor);

  await runtime.participantsWriteRepo.revokeAgent(agentId, caller);

  await runtime.auditRecorder.recordEvent({
    category: 'admin_agent_revoke',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: agentId,
    subjectKind: 'participant',
    reasonCode: null,
    detail: actor.detail,
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  return { revokedAgentId: agentId };
}
