// Unit tests of the register_session handler (ADR-026) over stubbed Auth and presence
// ports: the orchestration of the registration, claim and renewal paths. The real
// primitives, transactions and concurrency are covered by register-session.smoke.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { Agent, Hivekeeper, IdentityContext, UUIDv7 } from '#domain/auth/index.js';

import type { RequestContext } from '../types.js';

import { RegisterSessionInputSchema, createRegisterSessionHandler } from './register-session.js';

const OWNER_ID = '01900000-0000-7000-8000-000000000001' as UUIDv7;
const HIVE_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const COLONY_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const ENROLLMENT_JTI = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const AGENT_ID = '01900000-0000-7000-8000-000000000005' as UUIDv7;
const REQUEST_ID = '01900000-0000-7000-8000-000000000006' as UUIDv7;
const WORKER_JTI = '01900000-0000-7000-8000-000000000007' as UUIDv7;
const EXPIRES_AT = new Date('2026-11-06T13:00:00.000Z');

const OWNER: Hivekeeper = {
  id: OWNER_ID,
  hiveId: HIVE_ID,
  colonyId: COLONY_ID,
  email: 'Alice@example.com',
  displayName: 'Alice',
  isAdmin: false,
  state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  revokedAt: null,
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId: OWNER_ID,
    name: 'claude-api',
    type: 'worker',
    capabilities: [],
    instructions: '',
    state: 'active',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    revokedAt: null,
    lastConnectedAt: null,
    origin: 'enrollment',
    enrolledVia: ENROLLMENT_JTI,
    description: 'Works on the API',
    retiredAt: null,
    lastWorkerJti: WORKER_JTI,
    ...overrides,
  };
}

function enrollCtx(namePrefix?: string): RequestContext {
  const identity: IdentityContext = {
    participantId: OWNER_ID,
    kind: 'hivekeeper',
    hiveId: HIVE_ID,
    hiveName: 'acme',
    colonyId: COLONY_ID,
    snapshot: {
      issuedAt: new Date(),
      credentialJti: ENROLLMENT_JTI,
      credentialKid: 'kid',
      scope: 'enroll',
      ...(namePrefix !== undefined && { namePrefix }),
    },
    current: { state: 'active' },
  };
  return { identity, requestId: REQUEST_ID };
}

function renewalCtx(): RequestContext {
  const identity: IdentityContext = {
    participantId: AGENT_ID,
    kind: 'worker',
    hiveId: HIVE_ID,
    hiveName: 'acme',
    colonyId: COLONY_ID,
    ownerId: OWNER_ID,
    snapshot: {
      issuedAt: new Date(),
      credentialJti: WORKER_JTI,
      credentialKid: 'kid',
      renewal: true,
    },
    current: { state: 'active', type: 'worker' },
  };
  return { identity, requestId: REQUEST_ID };
}

function token(jti: string) {
  return { jti, jwt: `jwt-${jti}`, expiresAt: EXPIRES_AT, participantId: AGENT_ID, kid: 'kid' };
}

function build(existing: Agent | null = null, live = false) {
  const deps = {
    enrollment: {
      createEnrolledAgent: vi.fn(() =>
        Promise.resolve({ agent: agent(), token: token('new-jti') }),
      ),
      claimEnrolledAgent: vi.fn(() =>
        Promise.resolve({ agent: agent(), token: token('claim-jti') }),
      ),
      renewWorkerToken: vi.fn(() => Promise.resolve(token('renew-jti'))),
    },
    participantsRepo: {
      findAgentByName: vi.fn(() => Promise.resolve(existing)),
      findAgentById: vi.fn(() => Promise.resolve(existing ?? agent())),
      findHivekeeperById: vi.fn(() => Promise.resolve(OWNER)),
    },
    presenceRegistry: {
      isHolderLive: vi.fn(() => live),
      claimHolder: vi.fn((): { outcome: 'granted' | 'in_use' } => ({ outcome: 'granted' })),
      releaseClaim: vi.fn(),
    },
    rebindParticipantStreams: vi.fn(() => 0),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  const handler = createRegisterSessionHandler(deps);
  return { deps, handler };
}

const INPUT = { name: 'claude-api', description: 'Works on the API' };

async function expectAuthError(promise: Promise<unknown>, code: string, subCode?: string) {
  const err = await promise.then(
    () => expect.fail(`expected ${code}`),
    (e: unknown) => e,
  );
  expect(err).toMatchObject({ name: 'AuthError', code, ...(subCode && { subCode }) });
}

describe('RegisterSessionInputSchema', () => {
  it('requires name and a description of 1 to 280 characters', () => {
    expect(RegisterSessionInputSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(RegisterSessionInputSchema.safeParse({ name: 'a', description: '' }).success).toBe(
      false,
    );
    expect(
      RegisterSessionInputSchema.safeParse({ name: 'a', description: 'x'.repeat(281) }).success,
    ).toBe(false);
    expect(
      RegisterSessionInputSchema.safeParse({ name: 'a', description: 'x', capabilities: ['c'] })
        .success,
    ).toBe(true);
  });
});

describe('register_session — registration with the enrollment credential', () => {
  it('creates a new Agent when the name does not exist (outcome created)', async () => {
    const { deps, handler } = build(null);
    const ctx = enrollCtx();

    const result = await handler({ ...INPUT, capabilities: ['api'] }, ctx);

    expect(deps.enrollment.createEnrolledAgent).toHaveBeenCalledWith(
      {
        ownerId: OWNER_ID,
        name: 'claude-api',
        description: 'Works on the API',
        capabilities: ['api'],
        enrolledVia: ENROLLMENT_JTI,
      },
      ctx.identity,
    );
    expect(deps.presenceRegistry.claimHolder).not.toHaveBeenCalled();
    expect(result.outcome).toBe('created');
    expect(result.output).toEqual({
      agent_ref: 'claude-api@alice.acme',
      agent_id: AGENT_ID,
      token: 'jwt-new-jti',
      expires_at: '2026-11-06T13:00:00.000Z',
    });
  });

  it.each([
    ['Bad_Name', undefined, 'name_malformed'],
    ['other-api', 'claude-', 'name_prefix_mismatch'],
  ])(
    'rejects %s (prefix %s) with INVALID_INPUT{%s} before any lookup',
    async (name, prefix, sub) => {
      const { deps, handler } = build(null);

      await expectAuthError(handler({ ...INPUT, name }, enrollCtx(prefix)), 'INVALID_INPUT', sub);
      expect(deps.participantsRepo.findAgentByName).not.toHaveBeenCalled();
    },
  );

  it.each(['two\nlines', 'tab\there', '   '])(
    'rejects the description %j with INVALID_INPUT{description_invalid}',
    async (description) => {
      const { handler } = build(null);

      await expectAuthError(
        handler({ ...INPUT, description }, enrollCtx()),
        'INVALID_INPUT',
        'description_invalid',
      );
    },
  );

  it.each([
    ['a manual Agent', agent({ origin: 'manual', enrolledVia: null })],
    ['a Scout', agent({ type: 'scout' })],
  ])('answers NAME_TAKEN for %s', async (_label, existing) => {
    const { deps, handler } = build(existing);

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_TAKEN');
    expect(deps.presenceRegistry.claimHolder).not.toHaveBeenCalled();
  });

  it('answers AGENT_SUSPENDED for a suspended Agent', async () => {
    const { handler } = build(agent({ state: 'suspended' }));

    await expectAuthError(handler(INPUT, enrollCtx()), 'AGENT_SUSPENDED');
  });

  it('answers NAME_IN_USE while the holder has a live stream, without reserving', async () => {
    const { deps, handler } = build(agent(), true);

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_IN_USE');
    expect(deps.presenceRegistry.claimHolder).not.toHaveBeenCalled();
    expect(deps.enrollment.claimEnrolledAgent).not.toHaveBeenCalled();
  });

  it('answers NAME_IN_USE when another claim holds the reservation', async () => {
    const { deps, handler } = build(agent());
    deps.presenceRegistry.claimHolder.mockReturnValue({ outcome: 'in_use' });

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_IN_USE');
    expect(deps.enrollment.claimEnrolledAgent).not.toHaveBeenCalled();
  });

  it('claims an offline holder: reserves with the requestId, then the Auth transaction', async () => {
    const { deps, handler } = build(agent());
    const ctx = enrollCtx();

    const result = await handler(INPUT, ctx);

    expect(deps.presenceRegistry.claimHolder).toHaveBeenCalledWith(AGENT_ID, REQUEST_ID);
    expect(deps.enrollment.claimEnrolledAgent).toHaveBeenCalledWith(
      { agentId: AGENT_ID, description: 'Works on the API', enrolledVia: ENROLLMENT_JTI },
      ctx.identity,
    );
    expect(deps.presenceRegistry.releaseClaim).not.toHaveBeenCalled();
    expect(result.outcome).toBe('claimed');
    expect(result.output.token).toBe('jwt-claim-jti');
  });

  it('releases the reservation and propagates when the claim transaction fails', async () => {
    const { deps, handler } = build(agent());
    deps.enrollment.claimEnrolledAgent.mockRejectedValue(new AuthError('CREDENTIAL_REVOKED'));

    await expectAuthError(handler(INPUT, enrollCtx()), 'CREDENTIAL_REVOKED');
    expect(deps.presenceRegistry.releaseClaim).toHaveBeenCalledWith(AGENT_ID, REQUEST_ID);
  });

  it('propagates the NAME_IN_USE of a concurrent create that lost the unique index', async () => {
    const { deps, handler } = build(null);
    deps.enrollment.createEnrolledAgent.mockRejectedValue(new AuthError('NAME_IN_USE'));

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_IN_USE');
  });
});

describe('register_session — renewal with the last Worker token', () => {
  it('renews without reserving, updates the description and re-binds the streams', async () => {
    const { deps, handler } = build(agent());

    const result = await handler({ ...INPUT, capabilities: ['api'] }, renewalCtx());

    expect(deps.enrollment.renewWorkerToken).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      presentedJti: WORKER_JTI,
      description: 'Works on the API',
      capabilities: ['api'],
    });
    expect(deps.presenceRegistry.isHolderLive).not.toHaveBeenCalled();
    expect(deps.presenceRegistry.claimHolder).not.toHaveBeenCalled();
    expect(deps.rebindParticipantStreams).toHaveBeenCalledWith(AGENT_ID, {
      jti: 'renew-jti',
      expiresAt: EXPIRES_AT,
    });
    expect(result.outcome).toBe('renewed');
    expect(result.output).toEqual({
      agent_ref: 'claude-api@alice.acme',
      agent_id: AGENT_ID,
      token: 'jwt-renew-jti',
      expires_at: '2026-11-06T13:00:00.000Z',
    });
  });

  it('rejects a name other than the Agent of the Bearer with renewal_name_mismatch', async () => {
    const { deps, handler } = build(agent());

    await expectAuthError(
      handler({ ...INPUT, name: 'claude-web' }, renewalCtx()),
      'INVALID_INPUT',
      'renewal_name_mismatch',
    );
    expect(deps.enrollment.renewWorkerToken).not.toHaveBeenCalled();
  });

  it('does not re-bind when the renewal fails', async () => {
    const { deps, handler } = build(agent());
    deps.enrollment.renewWorkerToken.mockRejectedValue(
      new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_superseded' }),
    );

    await expectAuthError(handler(INPUT, renewalCtx()), 'CREDENTIAL_INAUTHENTIC');
    expect(deps.rebindParticipantStreams).not.toHaveBeenCalled();
  });
});

describe('register_session — identity guard', () => {
  it('refuses a full credential that is neither an enrollment nor a renewal', async () => {
    const { handler } = build(null);
    const ctx = renewalCtx();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
    const { renewal, ...snapshot } = ctx.identity.snapshot;

    await expectAuthError(
      handler(INPUT, { ...ctx, identity: { ...ctx.identity, snapshot } }),
      'INSUFFICIENT_PRIVILEGE',
    );
  });
});
