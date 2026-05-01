import { z } from 'zod';

import { CellError, isCellError } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';

import type { ReferenceResolver } from '../reference-resolver.js';
import type { RequestContext } from '../types.js';

export const GetAgentStatusInputSchema = z
  .object({
    participant: z.string().min(1),
  })
  .strict();

export type GetAgentStatusInput = z.infer<typeof GetAgentStatusInputSchema>;

export interface GetAgentStatusOutput {
  participant_id: string;
  presence: 'online' | 'offline';
  last_connected_at: string | null;
}

export interface GetAgentStatusDeps {
  participantsRepo: ParticipantsReadRepo;
  presenceRegistry: PresenceRegistry;
  visibilityEngine: VisibilityEngine;
  resolver: ReferenceResolver;
}

export function createGetAgentStatusHandler(deps: GetAgentStatusDeps) {
  return async function getAgentStatus(
    input: GetAgentStatusInput,
    ctx: RequestContext,
  ): Promise<GetAgentStatusOutput> {
    // Step 1: parse the reference. RECIPIENT_UNREACHABLE (reference_unresolved)
    // collapses with visibility-denied below for uniform privacy. Other errors
    // (eg. INVALID_INPUT reference_unparseable) propagate.
    let targetId;
    try {
      targetId = await deps.resolver.resolveParticipantReference(input.participant, ctx.identity);
    } catch (err) {
      if (
        isCellError(err) &&
        err.code === 'RECIPIENT_UNREACHABLE' &&
        err.subCode === 'reference_unresolved'
      ) {
        throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
      }
      throw err;
    }

    // Step 2: visibility gate. Indistinguishable-from-not-existing on deny —
    // see [[API MCP — Tools]] § Tool 7 (privacy uniform with list_agents +
    // send_message recipient resolution).
    const visible = await deps.visibilityEngine.canSee({
      callerContext: ctx.identity,
      targetId,
      requestId: ctx.requestId,
    });
    if (!visible) {
      throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
    }

    // Step 3: pull both presence + DB state. Both are indispensable: presence
    // alone cannot detect `suspended` (an agent may be holding sessions yet be
    // administratively offline); state alone cannot detect "online effective".
    const presence = deps.presenceRegistry.getPresence(targetId);
    const participantState = await deps.participantsRepo.getParticipantState(targetId);

    // Step 4: resolve effective presence. Per the product spec Tool 7 —
    // `online` iff the registry sees a live session AND the DB state is
    // `active`. A suspended/revoked agent that still holds an open session
    // reports as `offline` (state internal — never crosses the wire).
    const isStateActive = participantState !== null && participantState.state === 'active';
    const effectiveOnline = presence.online && isStateActive;

    if (effectiveOnline) {
      // Step 5a: derive last_connected_at from the live sessions. A guard for
      // the inconsistency edge case (online with empty sessions) returns null
      // rather than crashing — see PRY-030 risks table.
      const max = maxOf(presence.sessionsSubscribedAt);
      return {
        participant_id: targetId,
        presence: 'online',
        last_connected_at: max !== null ? max.toISOString() : null,
      };
    }

    // Step 5b: offline path. Read the persisted column. Hivekeepers never have
    // an `agents` row, so `findAgentById` returns null → the wire field stays
    // null. (The visibility check above already authorizes the read.)
    const agent = await deps.participantsRepo.findAgentById(targetId);
    return {
      participant_id: targetId,
      presence: 'offline',
      last_connected_at:
        agent !== null && agent.lastConnectedAt !== null
          ? agent.lastConnectedAt.toISOString()
          : null,
    };
  };
}

function maxOf(timestamps: readonly Date[]): Date | null {
  if (timestamps.length === 0) return null;
  let latest = timestamps[0]!;
  for (let i = 1; i < timestamps.length; i++) {
    const t = timestamps[i]!;
    if (t.getTime() > latest.getTime()) latest = t;
  }
  return latest;
}
