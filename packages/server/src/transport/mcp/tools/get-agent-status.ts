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
  /** ADR-026: only for an Agent target; declared by the Agent, untrusted, `""` when none. */
  description?: string;
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
    // alone cannot detect `suspended` (an agent may hold a stream yet be
    // administratively offline); state alone cannot detect "reachable by push".
    const presence = deps.presenceRegistry.getPresence(targetId);
    const participantState = await deps.participantsRepo.getParticipantState(targetId);

    // Step 4: `online` means reachable by push: the registry sees a stream on the
    // caller-owned mailbox AND the DB state is `active`. An agent that only calls
    // tools holds no stream, so it reports `offline` however recent its last request.
    const isStateActive = participantState !== null && participantState.state === 'active';
    const effectiveOnline = presence.online && isStateActive;

    // Step 5: last_connected_at is the last authenticated request, read from the
    // persisted column for both presences. Hivekeepers have no `agents` row, so
    // the wire field stays null.
    const agent = await deps.participantsRepo.findAgentById(targetId);
    return {
      participant_id: targetId,
      presence: effectiveOnline ? 'online' : 'offline',
      last_connected_at: agent?.lastConnectedAt?.toISOString() ?? null,
      ...(agent && { description: agent.description ?? '' }),
    };
  };
}
