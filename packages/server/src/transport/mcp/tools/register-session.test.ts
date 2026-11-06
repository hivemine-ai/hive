// Unit tests of the register_session handler (ADR-026) over stubbed Auth and presence
// ports: the orchestration of the registration, claim and renewal paths. The real
// primitives, transactions and concurrency are covered by register-session.smoke.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { Agent, Hivekeeper, IdentityContext, UUIDv7 } from '#domain/auth/index.js';

import { createRejectAlertCounter } from '../enrollment-guards.js';
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
      reviveRetiredAgent: vi.fn(() =>
        Promise.resolve({ agent: agent(), token: token('revive-jti') }),
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
    rejectAlerts: createRejectAlertCounter({ threshold: 2, windowMinutes: 10 }),
    rejectAlertWindowMinutes: 10,
    sender: {
      depositSystemNotification: vi.fn(() =>
        Promise.resolve({
          messageId: 'm',
          sentAt: new Date(),
          storedAt: new Date(),
          replayed: false,
        }),
      ),
    },
    auditRecorder: { recordEvent: vi.fn(() => Promise.resolve()) },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  const handler = createRegisterSessionHandler(deps);
  return { deps, handler };
}

const DESCRIPTION_TEXT = 'Works on the API';
const INPUT = { name: 'claude-api', description: DESCRIPTION_TEXT };

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
    expect(deps.enrollment.claimEnrolledAgent).not.toHaveBeenCalled();
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

  // PRY-094: the retired branch replaces the provisional INVALID_STATE_TRANSITION of PRY-091.
  const RETIRED_AT = new Date('2026-10-01T00:00:00.000Z');

  it('revives a retired Agent: reserves, then reviveRetiredAgent (outcome revived)', async () => {
    const { deps, handler } = build(agent({ state: 'retired', retiredAt: RETIRED_AT }));
    const ctx = enrollCtx();

    const result = await handler(INPUT, ctx);

    expect(deps.presenceRegistry.claimHolder).toHaveBeenCalledWith(AGENT_ID, REQUEST_ID);
    expect(deps.enrollment.reviveRetiredAgent).toHaveBeenCalledWith(
      { agentId: AGENT_ID, description: 'Works on the API', enrolledVia: ENROLLMENT_JTI },
      ctx.identity,
    );
    expect(deps.enrollment.claimEnrolledAgent).not.toHaveBeenCalled();
    expect(result.outcome).toBe('revived');
    expect(result.output.token).toBe('jwt-revive-jti');
    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'agent_revived',
        actorId: OWNER_ID,
        actorKind: 'hivekeeper',
        subjectId: AGENT_ID,
        detail: {
          enrolledVia: ENROLLMENT_JTI,
          retiredAt: RETIRED_AT.toISOString(),
          viaEnrollmentJti: ENROLLMENT_JTI,
        },
      }),
    );
  });

  it('answers NAME_IN_USE for a retired Agent whose holder is still live', async () => {
    const { deps, handler } = build(agent({ state: 'retired', retiredAt: RETIRED_AT }), true);

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_IN_USE');
    expect(deps.enrollment.reviveRetiredAgent).not.toHaveBeenCalled();
  });

  it('releases the reservation when the revival fails on the quota, and counts the rejection', async () => {
    const { deps, handler } = build(agent({ state: 'retired', retiredAt: RETIRED_AT }));
    deps.enrollment.reviveRetiredAgent.mockRejectedValue(
      new AuthError('ENROLLMENT_QUOTA_EXCEEDED', { limit: 1 }),
    );

    await expectAuthError(handler(INPUT, enrollCtx()), 'ENROLLMENT_QUOTA_EXCEEDED');
    expect(deps.presenceRegistry.releaseClaim).toHaveBeenCalledWith(AGENT_ID, REQUEST_ID);
  });

  it('retired between the read and the claim: evaluated once more, it revives', async () => {
    const { deps, handler } = build(agent());
    deps.participantsRepo.findAgentByName
      .mockResolvedValueOnce(agent())
      .mockResolvedValueOnce(agent({ state: 'retired', retiredAt: RETIRED_AT }));
    deps.enrollment.claimEnrolledAgent.mockRejectedValue(
      new AuthError('INVALID_STATE_TRANSITION', {
        subCode: 'claim_requires_active_enrollment_agent',
      }),
    );

    const result = await handler(INPUT, enrollCtx());

    expect(result.outcome).toBe('revived');
    expect(deps.presenceRegistry.releaseClaim).toHaveBeenCalledOnce();
    expect(deps.presenceRegistry.claimHolder).toHaveBeenCalledTimes(2);
  });

  it('revoked by the end of grace before the revival: evaluated once more, it creates', async () => {
    const { deps, handler } = build(agent({ state: 'retired', retiredAt: RETIRED_AT }));
    deps.participantsRepo.findAgentByName
      .mockResolvedValueOnce(agent({ state: 'retired', retiredAt: RETIRED_AT }))
      .mockResolvedValueOnce(null);
    deps.enrollment.reviveRetiredAgent.mockRejectedValue(
      new AuthError('INVALID_STATE_TRANSITION', {
        subCode: 'revive_requires_retired_enrollment_agent',
      }),
    );

    const result = await handler(INPUT, enrollCtx());

    expect(result.outcome).toBe('created');
  });

  it('retries once only: a second state move propagates', async () => {
    const { deps, handler } = build(agent());
    deps.enrollment.claimEnrolledAgent.mockRejectedValue(
      new AuthError('INVALID_STATE_TRANSITION', {
        subCode: 'claim_requires_active_enrollment_agent',
      }),
    );

    await expectAuthError(
      handler(INPUT, enrollCtx()),
      'INVALID_STATE_TRANSITION',
      'claim_requires_active_enrollment_agent',
    );
    expect(deps.enrollment.claimEnrolledAgent).toHaveBeenCalledTimes(2);
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

describe('register_session — repeated rejections and owner notices', () => {
  it('alerts once at the threshold: one audit event and one system notification', async () => {
    const { deps, handler } = build(agent({ origin: 'manual', enrolledVia: null }));

    for (let i = 0; i < 3; i += 1) {
      await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_TAKEN');
    }

    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledTimes(1);
    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'enrollment_reject_alert',
        decision: 'deny',
        actorId: OWNER_ID,
        actorKind: 'hivekeeper',
        subjectId: AGENT_ID,
        subjectKind: 'participant',
        hiveId: HIVE_ID,
        requestId: REQUEST_ID,
        detail: {
          name: 'claude-api',
          rejections: 2,
          windowMinutes: 10,
          enrolledVia: ENROLLMENT_JTI,
          viaEnrollmentJti: ENROLLMENT_JTI,
        },
      }),
    );
    expect(deps.sender.depositSystemNotification).toHaveBeenCalledTimes(1);
    expect(deps.sender.depositSystemNotification).toHaveBeenCalledWith(
      {
        recipientId: OWNER_ID,
        body: "Hive: 2 rejected session registrations for name 'claude-api' in 10 min. If this was not you, revoke the enrollment credential.",
        action: {
          kind: 'enrollment_reject_alert',
          name: 'claude-api',
          enrolledVia: ENROLLMENT_JTI,
        },
      },
      { kind: 'system' },
    );
  });

  it('counts a name_prefix_mismatch, and an alert for a name that never existed has no subject', async () => {
    const { deps, handler } = build(null);

    for (let i = 0; i < 2; i += 1) {
      await expectAuthError(
        handler({ ...INPUT, name: 'other-api' }, enrollCtx('claude-')),
        'INVALID_INPUT',
      );
    }

    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: null, subjectKind: null }),
    );
  });

  it('does not count a malformed name, an invalid description or an auth failure', async () => {
    const { deps, handler } = build(null);
    deps.enrollment.createEnrolledAgent.mockRejectedValue(new AuthError('CREDENTIAL_REVOKED'));

    for (let i = 0; i < 3; i += 1) {
      await handler({ ...INPUT, name: 'Bad' }, enrollCtx()).catch(() => undefined);
      await handler({ ...INPUT, description: 'a\nb' }, enrollCtx()).catch(() => undefined);
      await handler(INPUT, enrollCtx()).catch(() => undefined);
    }

    expect(deps.auditRecorder.recordEvent).not.toHaveBeenCalled();
    expect(deps.sender.depositSystemNotification).not.toHaveBeenCalled();
  });

  it('notifies the owner of a created Agent, and only of a created one', async () => {
    const created = build(null);
    await created.handler(INPUT, enrollCtx());
    const claimed = build(agent());
    await claimed.handler(INPUT, enrollCtx());

    expect(created.deps.sender.depositSystemNotification).toHaveBeenCalledWith(
      {
        recipientId: OWNER_ID,
        body: `Hive: new session agent claude-api@alice.acme registered via enrollment credential ${ENROLLMENT_JTI}.`,
        action: {
          kind: 'agent_enrolled',
          agentRef: 'claude-api@alice.acme',
          enrolledVia: ENROLLMENT_JTI,
        },
      },
      { kind: 'system' },
    );
    expect(claimed.deps.sender.depositSystemNotification).not.toHaveBeenCalled();
  });

  it('a failed notice is logged and never fails the registration', async () => {
    const { deps, handler } = build(null);
    deps.sender.depositSystemNotification.mockRejectedValue(new Error('cell closed'));

    const result = await handler(INPUT, enrollCtx());

    expect(result.outcome).toBe('created');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { event: 'mcp_enrollment_notify_failed', kind: 'agent_enrolled' },
      expect.any(String),
    );
  });
});

describe('register_session — audit of registrations', () => {
  it('records agent_enrolled for a created Agent, with the owner as actor', async () => {
    const { deps, handler } = build(null);

    await handler(INPUT, enrollCtx());

    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'agent_enrolled',
        decision: 'success',
        actorId: OWNER_ID,
        actorKind: 'hivekeeper',
        subjectId: AGENT_ID,
        subjectKind: 'participant',
        detail: {
          agentRef: 'claude-api@alice.acme',
          enrolledVia: ENROLLMENT_JTI,
          viaEnrollmentJti: ENROLLMENT_JTI,
        },
        requestId: REQUEST_ID,
        hiveId: HIVE_ID,
      }),
    );
  });

  it('records agent_claimed with the previous enrollment of the Agent', async () => {
    const PREVIOUS = '01900000-0000-7000-8000-0000000000aa' as UUIDv7;
    const { deps, handler } = build(agent({ enrolledVia: PREVIOUS }));

    await handler(INPUT, enrollCtx());

    expect(deps.auditRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'agent_claimed',
        actorId: OWNER_ID,
        subjectId: AGENT_ID,
        detail: {
          enrolledVia: ENROLLMENT_JTI,
          previousEnrolledVia: PREVIOUS,
          viaEnrollmentJti: ENROLLMENT_JTI,
        },
      }),
    );
  });

  it('records nothing for a renewal, and never puts the token or the description in detail', async () => {
    const renewal = build(agent());
    await renewal.handler(INPUT, renewalCtx());
    expect(renewal.deps.auditRecorder.recordEvent).not.toHaveBeenCalled();

    const created = build(null);
    await created.handler(INPUT, enrollCtx());
    const recorded = JSON.stringify(created.deps.auditRecorder.recordEvent.mock.calls);
    expect(recorded).not.toContain('jwt-new-jti');
    expect(recorded).not.toContain(DESCRIPTION_TEXT);
  });
});

// The spec answers NAME_IN_USE to the loser of two concurrent registrations of a new
// name, also when it looks the name up after the winner committed: the creator holds the
// claim reservation of its new Agent until its stream opens (or the reservation expires).
describe('register_session — a created Agent is reserved for its creator', () => {
  it('reserves the new Agent with the requestId of the create', async () => {
    const { deps, handler } = build(null);

    await handler(INPUT, enrollCtx());

    expect(deps.presenceRegistry.claimHolder).toHaveBeenCalledWith(AGENT_ID, REQUEST_ID);
  });

  it('answers NAME_IN_USE to a registration that finds the Agent while its create is in flight', async () => {
    const { deps, handler } = build(null);
    let commit: (value: { agent: Agent; token: ReturnType<typeof token> }) => void = () =>
      undefined;
    deps.enrollment.createEnrolledAgent.mockReturnValue(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
    const creating = handler(INPUT, enrollCtx());
    // The second request sees the committed row before the creator resumes.
    deps.participantsRepo.findAgentByName.mockResolvedValue(agent());
    await new Promise((resolve) => setImmediate(resolve));

    await expectAuthError(handler(INPUT, enrollCtx()), 'NAME_IN_USE');
    expect(deps.enrollment.claimEnrolledAgent).not.toHaveBeenCalled();

    commit({ agent: agent(), token: token('new-jti') });
    await expect(creating).resolves.toMatchObject({ outcome: 'created' });
  });
});
