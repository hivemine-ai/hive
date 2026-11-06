import { describe, expect, it } from 'vitest';

import type { Agent, Hivekeeper, IdentityContext } from '#domain/auth/index.js';

import { adaptAgentConfig } from './agent-config-view.js';

const AGENT = {
  id: '01900000-0000-7000-8000-000000000001',
  hiveId: '01900000-0000-7000-8000-000000000002',
  colonyId: '01900000-0000-7000-8000-000000000003',
  ownerId: '01900000-0000-7000-8000-000000000004',
  capabilities: ['review'],
  instructions: 'Be brief.',
  description: 'Reviews pull requests',
} as Agent;

function identity(kind: IdentityContext['kind']): IdentityContext {
  return { kind } as IdentityContext;
}

describe('adaptAgentConfig — description (ADR-026)', () => {
  it('returns the description of an Agent next to its instructions', () => {
    expect(adaptAgentConfig(AGENT, identity('worker'))).toMatchObject({
      instructions: 'Be brief.',
      description: 'Reviews pull requests',
    });
  });

  it('returns an empty description for an Agent without one', () => {
    expect(adaptAgentConfig({ ...AGENT, description: null }, identity('worker')).description).toBe(
      '',
    );
  });

  it('omits it for a Hivekeeper', () => {
    const keeper = { id: AGENT.id, hiveId: AGENT.hiveId, colonyId: AGENT.colonyId } as Hivekeeper;

    expect(adaptAgentConfig(keeper, identity('hivekeeper'))).not.toHaveProperty('description');
  });
});
