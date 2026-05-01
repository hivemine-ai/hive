import { describe, expect, it, vi } from 'vitest';

import { CellError, isCellError } from '#domain/cells/index.js';
import type { Agent, ParticipantsReadRepo, UUIDv7 } from '#domain/auth/index.js';
import type { PresenceRegistry, PresenceSnapshot } from '#domain/notifications/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';

import type { ReferenceResolver } from '../reference-resolver.js';
import type { RequestContext } from '../types.js';

import { GetAgentStatusInputSchema, createGetAgentStatusHandler } from './get-agent-status.js';

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

const CALLER_ID = '01900000-0000-7000-8000-000000000001' as UUIDv7;
const TARGET_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const HIVE_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const COLONY_ID = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const REQUEST_ID = '01900000-0000-7000-8000-000000000005' as UUIDv7;
const SESSION_ID = '01900000-0000-7000-8000-000000000006' as UUIDv7;

function makeCtx(): RequestContext {
  return {
    identity: {
      participantId: CALLER_ID,
      kind: 'hivekeeper',
      hiveId: HIVE_ID,
      hiveName: 'test-hive',
      colonyId: COLONY_ID,
      snapshot: {
        issuedAt: new Date('2026-01-01T00:00:00Z'),
        credentialJti: '01900000-0000-7000-8000-00000000000a',
        credentialKid: 'kid-001',
      },
      current: { state: 'active', isAdmin: true },
    },
    requestId: REQUEST_ID,
    sessionState: {
      sessionId: 'sid',
      identity: {} as RequestContext['identity'],
      connectionId: SESSION_ID,
      subscription: null,
      notifierRef: null,
      establishedAt: new Date(),
      lastSeenAt: new Date(),
      invalidated: false,
    },
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: TARGET_ID,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId: '01900000-0000-7000-8000-00000000000b',
    name: 'worker-1',
    type: 'worker',
    capabilities: [],
    instructions: '',
    state: 'active',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    revokedAt: null,
    lastConnectedAt: null,
    ...overrides,
  };
}

interface DepsBundle {
  participantsRepo: ParticipantsReadRepo;
  presenceRegistry: PresenceRegistry;
  visibilityEngine: VisibilityEngine;
  resolver: ReferenceResolver;
  resolveMock: ReturnType<typeof vi.fn>;
  canSeeMock: ReturnType<typeof vi.fn>;
  getPresenceMock: ReturnType<typeof vi.fn>;
  getParticipantStateMock: ReturnType<typeof vi.fn>;
  findAgentByIdMock: ReturnType<typeof vi.fn>;
}

function buildDeps(
  opts: {
    resolveResult?: UUIDv7 | Error;
    canSee?: boolean;
    presence?: PresenceSnapshot;
    participantState?: { state: 'active' | 'suspended' | 'revoked' } | null;
    agent?: Agent | null;
  } = {},
): DepsBundle {
  const resolveMock = vi.fn();
  if (opts.resolveResult instanceof Error) {
    resolveMock.mockRejectedValue(opts.resolveResult);
  } else {
    resolveMock.mockResolvedValue(opts.resolveResult ?? TARGET_ID);
  }

  const canSeeMock = vi.fn().mockResolvedValue(opts.canSee ?? true);
  const getPresenceMock = vi
    .fn()
    .mockReturnValue(opts.presence ?? { online: false, sessionCount: 0, sessionsSubscribedAt: [] });
  const getParticipantStateMock = vi
    .fn()
    .mockResolvedValue(
      opts.participantState === undefined
        ? {
            kind: 'worker',
            state: 'active',
            isAdmin: null,
            hiveId: HIVE_ID,
            colonyId: COLONY_ID,
            ownerId: null,
          }
        : opts.participantState,
    );
  const findAgentByIdMock = vi.fn().mockResolvedValue(opts.agent ?? null);

  const participantsRepo = {
    findAgentById: findAgentByIdMock,
    getParticipantState: getParticipantStateMock,
  } as unknown as ParticipantsReadRepo;

  const presenceRegistry = {
    getPresence: getPresenceMock,
  } as unknown as PresenceRegistry;

  const visibilityEngine = {
    canSee: canSeeMock,
  } as unknown as VisibilityEngine;

  const resolver = {
    resolveParticipantReference: resolveMock,
  } as unknown as ReferenceResolver;

  return {
    participantsRepo,
    presenceRegistry,
    visibilityEngine,
    resolver,
    resolveMock,
    canSeeMock,
    getPresenceMock,
    getParticipantStateMock,
    findAgentByIdMock,
  };
}

function invoke(
  handler: ReturnType<typeof createGetAgentStatusHandler>,
  raw: unknown,
  ctx: RequestContext,
): ReturnType<typeof handler> {
  return handler(GetAgentStatusInputSchema.parse(raw), ctx);
}

// ─────────────────────────────────────────────────────────────────────────
// Schema tests
// ─────────────────────────────────────────────────────────────────────────

describe('GetAgentStatusInputSchema', () => {
  it('accepts a non-empty string', () => {
    expect(() => GetAgentStatusInputSchema.parse({ participant: 'foo' })).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => GetAgentStatusInputSchema.parse({ participant: '' })).toThrow();
  });

  it('rejects missing participant', () => {
    expect(() => GetAgentStatusInputSchema.parse({})).toThrow();
  });

  it('is strict — rejects unknown keys', () => {
    expect(() => GetAgentStatusInputSchema.parse({ participant: 'foo', extra: 1 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Handler tests
// ─────────────────────────────────────────────────────────────────────────

describe('createGetAgentStatusHandler', () => {
  it('online — returns max(sessionsSubscribedAt) ISO string', async () => {
    const t1 = new Date('2026-05-01T10:00:00.000Z');
    const t2 = new Date('2026-05-01T11:30:00.000Z');
    const t3 = new Date('2026-05-01T11:00:00.000Z');
    const deps = buildDeps({
      presence: { online: true, sessionCount: 3, sessionsSubscribedAt: [t1, t2, t3] },
      participantState: { state: 'active' },
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out).toEqual({
      participant_id: TARGET_ID,
      presence: 'online',
      last_connected_at: t2.toISOString(),
    });
    expect(deps.findAgentByIdMock).not.toHaveBeenCalled();
  });

  it('online but participantState=suspended → reported as offline', async () => {
    const t1 = new Date('2026-05-01T10:00:00.000Z');
    const persisted = new Date('2026-04-30T08:00:00.000Z');
    const deps = buildDeps({
      presence: { online: true, sessionCount: 1, sessionsSubscribedAt: [t1] },
      participantState: { state: 'suspended' },
      agent: makeAgent({ state: 'suspended', lastConnectedAt: persisted }),
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out.presence).toBe('offline');
    expect(out.last_connected_at).toBe(persisted.toISOString());
  });

  it('offline with persisted last_connected_at → returns the persisted ISO string', async () => {
    const persisted = new Date('2026-04-30T08:00:00.000Z');
    const deps = buildDeps({
      presence: { online: false, sessionCount: 0, sessionsSubscribedAt: [] },
      participantState: { state: 'active' },
      agent: makeAgent({ lastConnectedAt: persisted }),
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out).toEqual({
      participant_id: TARGET_ID,
      presence: 'offline',
      last_connected_at: persisted.toISOString(),
    });
  });

  it('offline never-connected (last_connected_at null) → wire null', async () => {
    const deps = buildDeps({
      presence: { online: false, sessionCount: 0, sessionsSubscribedAt: [] },
      participantState: { state: 'active' },
      agent: makeAgent({ lastConnectedAt: null }),
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out.presence).toBe('offline');
    expect(out.last_connected_at).toBeNull();
  });

  it('visibility denied → CellError RECIPIENT_UNREACHABLE (privacy uniform)', async () => {
    const deps = buildDeps({ canSee: false });
    const handler = createGetAgentStatusHandler(deps);
    await expect(
      invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx()),
    ).rejects.toMatchObject({
      code: 'RECIPIENT_UNREACHABLE',
      subCode: 'reference_unresolved',
    });
    expect(deps.getPresenceMock).not.toHaveBeenCalled();
    expect(deps.findAgentByIdMock).not.toHaveBeenCalled();
  });

  it('reference unresolved → CellError RECIPIENT_UNREACHABLE (uniform with denied)', async () => {
    const deps = buildDeps({
      resolveResult: new CellError('RECIPIENT_UNREACHABLE', {
        subCode: 'reference_unresolved',
      }),
    });
    const handler = createGetAgentStatusHandler(deps);
    await expect(
      invoke(handler, { participant: 'ghost@nobody.test-hive' }, makeCtx()),
    ).rejects.toMatchObject({
      code: 'RECIPIENT_UNREACHABLE',
      subCode: 'reference_unresolved',
    });
  });

  it('reference unparseable → CellError INVALID_INPUT propagated', async () => {
    const deps = buildDeps({
      resolveResult: new CellError('INVALID_INPUT', { subCode: 'reference_unparseable' }),
    });
    const handler = createGetAgentStatusHandler(deps);
    await expect(invoke(handler, { participant: '???' }, makeCtx())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      subCode: 'reference_unparseable',
    });
  });

  it('online edge case: presence.online=true but sessionsSubscribedAt empty → null (no crash)', async () => {
    const deps = buildDeps({
      presence: { online: true, sessionCount: 0, sessionsSubscribedAt: [] },
      participantState: { state: 'active' },
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out.presence).toBe('online');
    expect(out.last_connected_at).toBeNull();
  });

  it('participantState=null (deleted between visibility and state read) → offline + null', async () => {
    const deps = buildDeps({
      presence: { online: false, sessionCount: 0, sessionsSubscribedAt: [] },
      participantState: null,
      agent: null,
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(out).toEqual({
      participant_id: TARGET_ID,
      presence: 'offline',
      last_connected_at: null,
    });
  });

  it('passes requestId through to canSee', async () => {
    const deps = buildDeps();
    const handler = createGetAgentStatusHandler(deps);
    await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(deps.canSeeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        requestId: REQUEST_ID,
      }),
    );
  });

  it('hivekeeper target — agent row is null but visible Hivekeeper → offline + null', async () => {
    const deps = buildDeps({
      presence: { online: false, sessionCount: 0, sessionsSubscribedAt: [] },
      participantState: { state: 'active' },
      agent: null, // findAgentById returns null because the target is a Hivekeeper, not an Agent.
    });
    const handler = createGetAgentStatusHandler(deps);
    const out = await invoke(handler, { participant: 'admin@test-hive' }, makeCtx());
    expect(out.last_connected_at).toBeNull();
  });

  it('does not invoke findAgentById on the online path (avoid extra DB hit)', async () => {
    const t = new Date('2026-05-01T10:00:00.000Z');
    const deps = buildDeps({
      presence: { online: true, sessionCount: 1, sessionsSubscribedAt: [t] },
      participantState: { state: 'active' },
    });
    const handler = createGetAgentStatusHandler(deps);
    await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
    expect(deps.findAgentByIdMock).not.toHaveBeenCalled();
  });

  it('thrown error has the expected CellError shape (isCellError true)', async () => {
    const deps = buildDeps({ canSee: false });
    const handler = createGetAgentStatusHandler(deps);
    try {
      await invoke(handler, { participant: 'worker-1@admin.test-hive' }, makeCtx());
      throw new Error('expected CellError to be thrown');
    } catch (err) {
      expect(isCellError(err)).toBe(true);
    }
  });
});
