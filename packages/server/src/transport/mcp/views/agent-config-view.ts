import type { Hivekeeper, Agent } from '#domain/auth/index.js';
import type { IdentityContext } from '#domain/auth/index.js';

/**
 * Wire shape returned by `get_agent_config`. Per the tech spec, ownerId,
 * capabilities and instructions are present ONLY for Agents (Workers/Scouts);
 * Hivekeepers omit them.
 */
export interface AgentConfigView {
  participant_id: string;
  kind: 'worker' | 'scout' | 'hivekeeper';
  hive_id: string;
  colony_id: string;
  owner_id?: string;
  capabilities?: string[];
  instructions?: string;
}

/**
 * Adapts the resolved Participant + the IdentityContext into the wire view.
 * `kind` is taken from `identity.kind` (vigente, not snapshot — the tech spec
 * is explicit about using the current type).
 */
export function adaptAgentConfig(
  participant: Hivekeeper | Agent,
  identity: IdentityContext,
): AgentConfigView {
  const base: AgentConfigView = {
    participant_id: participant.id,
    kind: identity.kind,
    hive_id: participant.hiveId,
    colony_id: participant.colonyId,
  };

  if (identity.kind !== 'hivekeeper') {
    const agent = participant as Agent;
    base.owner_id = agent.ownerId;
    base.capabilities = agent.capabilities;
    base.instructions = agent.instructions;
  }

  return base;
}
