import { z } from 'zod';

import { CellError } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';

import type { RequestContext } from '../types.js';
import { adaptAgentConfig, type AgentConfigView } from '#transport/mcp/views/agent-config-view.js';

export const GetAgentConfigInputSchema = z.object({}).strict();
export type GetAgentConfigInput = z.infer<typeof GetAgentConfigInputSchema>;

export interface GetAgentConfigDeps {
  participantsRepo: ParticipantsReadRepo;
}

export function createGetAgentConfigHandler(deps: GetAgentConfigDeps) {
  return async function getAgentConfig(
    _input: GetAgentConfigInput,
    ctx: RequestContext,
  ): Promise<AgentConfigView> {
    const participant = await deps.participantsRepo.findById(ctx.identity.participantId);
    if (!participant) {
      // Defense-in-depth: a verified IdentityContext should always resolve.
      throw new CellError('INTERNAL_INCONSISTENCY', { subCode: 'identity_resolves_to_null' });
    }
    const entity = participant.kind === 'hivekeeper' ? participant.hivekeeper : participant.agent;
    return adaptAgentConfig(entity, ctx.identity);
  };
}
