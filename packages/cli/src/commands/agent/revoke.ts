// `hivectl agent revoke <agent-ref> [--yes]` — revoke an agent and cascade-close
// its Cell via the cells hook (cross-domain TX, wired in PRY-002).
//
// Per ADR-020 PRY-040, the positional accepts UUID v7 OR agent-reference syntax
// (`<name>@<owner-local>.<hive>`). Resolution flows through the shared parser
// in `@hive/server` (`domain/auth/references/parser.ts`).

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { resolveAgentReference } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import { toCallerContext } from '#commands/hivekeeper/create.js';
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
  const agentId = await resolveAgentReference(opts.agentRef, runtime);
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
