// `hivectl agent release <agent-ref> --operator-id <owner> [--yes]` (ADR-026 decision 9.1).
//
// Frees the name held by a session whose stream still looks alive: every Worker token of
// the Agent that is valid or inside the holder-proof window goes to the blocklist, so the
// holder can neither call nor renew. The Agent keeps its state; the next register_session
// with that name claims it. Owner-only: `--operator-id` must be the Agent's owner (the
// shell stays the trust anchor; the flag declares on whose behalf it acts).

import { AuthError, isAuthError } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { buildOperatorDetail } from '#audit/operator-actor.js';
import { CliError } from '#error/cli-error.js';
import { resolveAgentReference, resolveOperatorId } from '#input/parse-reference.js';
import type { GlobalCliOpts } from '#types.js';

export interface ReleaseAgentOpts {
  globals: GlobalCliOpts;
  agentRef: string;
}

export interface ReleaseAgentResult {
  agentId: UUIDv7;
  revokedHolderTokens: number;
  message: string;
}

const RELEASED_MESSAGE =
  'holder tokens revoked; a live stream drops on the next server re-verification ' +
  '(HIVE_MCP_REVERIFY_INTERVAL_SECONDS, 60 s by default) or when its lease expires, ' +
  'whichever comes first; until then the name still answers name_in_use';

export async function runReleaseAgent(
  runtime: CliRuntime,
  opts: ReleaseAgentOpts,
): Promise<ReleaseAgentResult> {
  if (!opts.globals.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: 'agent release can cut a live session; pass --yes to confirm',
    });
  }
  const agentId = await resolveAgentReference(opts.agentRef, runtime);
  const agent = await runtime.participantsRepo.findAgentById(agentId);
  if (!agent) throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'agent_not_found' });

  const ownerId = await resolveOwner(opts.globals.operatorId, runtime);
  if (ownerId !== agent.ownerId) {
    throw new CliError('OPERATOR_ID_NOT_OWNER', { subCode: 'release_owner_only' });
  }
  if (agent.origin !== 'enrollment') {
    throw new AuthError('INVALID_STATE_TRANSITION', {
      subCode: 'release_requires_enrollment_agent',
    });
  }
  if (agent.state === 'revoked') {
    throw new AuthError('INVALID_STATE_TRANSITION', { subCode: 'agent_revoked' });
  }

  const { revokedTokenJtis } = await runtime.enrollment.revokeWorkerTokens(
    { agentId, revokedBy: ownerId, reason: 'agent_release' },
    { kind: 'system' },
  );
  const revokedHolderTokens = revokedTokenJtis.length;

  await runtime.auditRecorder.recordEvent({
    category: 'admin_agent_release',
    decision: 'success',
    actorId: ownerId,
    actorKind: 'hivekeeper',
    subjectId: agentId,
    subjectKind: 'participant',
    reasonCode: null,
    detail: { ...buildOperatorDetail(opts.globals), revokedHolderTokens },
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  return {
    agentId,
    revokedHolderTokens,
    message: revokedHolderTokens === 0 ? 'no active holder' : RELEASED_MESSAGE,
  };
}

// A missing --operator-id, or one that resolves to nobody, is not the owner either.
async function resolveOwner(input: string | undefined, runtime: CliRuntime): Promise<UUIDv7> {
  if (input === undefined) {
    throw new CliError('OPERATOR_ID_NOT_OWNER', { subCode: 'release_owner_only' });
  }
  try {
    return await resolveOperatorId(input, runtime);
  } catch (err) {
    if (isAuthError(err) && err.code === 'PARTICIPANT_NOT_FOUND') {
      throw new CliError('OPERATOR_ID_NOT_OWNER', { subCode: 'release_owner_only' });
    }
    throw err;
  }
}
