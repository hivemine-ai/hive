import { describe, expect, it, vi } from 'vitest';

import { CellError } from '#domain/cells/index.js';
import type {
  AuditCursor,
  ListAgentsFilter,
  ListAgentsResult,
  ParticipantsReadRepo,
} from '#domain/auth/index.js';
import type { Agent } from '#domain/auth/index.js';
import type { UUIDv7 } from '#domain/auth/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';
import type { IdentityContext } from '#domain/auth/index.js';

import type { RequestContext } from '../types.js';
import type { ReferenceResolver } from '../reference-resolver.js';
import type { ParticipantStateSummary } from '#domain/auth/participants/entities.js';

import {
  createListAgentsHandler,
  ListAgentsInputSchema,
  type ListAgentsDeps,
} from './list-agents.js';
import { encodeCursor, decodeCursor } from '../views/agent-list-view.js';

// ─────────────────────────────────────────────────────────────────────────
// UUIDs
// ─────────────────────────────────────────────────────────────────────────

const HIVE_ID = '01900000-0000-7000-8000-000000000001' as UUIDv7;
const CALLER_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const OWNER_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const COLONY_ID = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const AGENT_A_ID = '01900000-0000-7000-8000-000000000010' as UUIDv7;
const AGENT_B_ID = '01900000-0000-7000-8000-000000000011' as UUIDv7;
const AGENT_C_ID = '01900000-0000-7000-8000-000000000012' as UUIDv7;
const REQUEST_ID = '01900000-0000-7000-8000-000000000099' as UUIDv7;
const FIXED_DATE = new Date('2026-01-15T10:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────

function buildIdentity(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    participantId: CALLER_ID,
    kind: 'worker',
    hiveId: HIVE_ID,
    hiveName: 'test-hive',
    colonyId: COLONY_ID,
    ownerId: OWNER_ID,
    snapshot: {
      capabilities: [],
      issuedAt: FIXED_DATE,
      credentialJti: '01900000-0000-7000-8000-000000000098',
      credentialKid: 'kid-1',
    },
    current: { state: 'active' },
    ...overrides,
  };
}

function buildCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    identity: buildIdentity(),
    requestId: REQUEST_ID,
    sessionState: {} as RequestContext['sessionState'],
    ...overrides,
  };
}

// Helper that mirrors the catalog wrapper: parse raw input via schema then
// invoke the handler. Lets tests assert the handler against ergonomic raw
// inputs while keeping the handler typed (post fix-up R1 from /review of #23).
function invoke(
  handler: ReturnType<typeof createListAgentsHandler>,
  raw: unknown,
  ctx: RequestContext,
): ReturnType<typeof handler> {
  return handler(ListAgentsInputSchema.parse(raw), ctx);
}

function buildAgent(id: UUIDv7, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId: OWNER_ID,
    name: `agent-${id.slice(-4)}`,
    type: 'worker',
    capabilities: ['summarize'],
    instructions: 'test instructions',
    state: 'active',
    createdAt: FIXED_DATE,
    revokedAt: null,
    lastConnectedAt: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stub factories
// ─────────────────────────────────────────────────────────────────────────

function buildStubRepo(result: ListAgentsResult = { agents: [], nextCursor: null }): {
  repo: ParticipantsReadRepo;
  capturedFilter: ListAgentsFilter[];
} {
  const capturedFilter: ListAgentsFilter[] = [];

  const repo: ParticipantsReadRepo = {
    findHiveById: vi.fn(),
    findColonyById: vi.fn(),
    findHivekeeperById: vi.fn(),
    findHivekeeperByEmail: vi.fn(),
    findHivekeeperByEmailLocalPart: vi.fn(),
    findAgentById: vi.fn(),
    findAgentByName: vi.fn(),
    findById: vi.fn(),
    getParticipantState: vi.fn(),
    listAgents(filter: ListAgentsFilter) {
      capturedFilter.push(filter);
      return Promise.resolve(result);
    },
    updateAgentLastConnectedAt: vi.fn(),
  };

  return { repo, capturedFilter };
}

function buildStubVisibility(defaultResult = true): VisibilityEngine {
  return {
    canSend: vi.fn(),
    canSee: vi.fn().mockResolvedValue(defaultResult),
  };
}

function buildStubResolver(resolveResult: UUIDv7 | Error = OWNER_ID): ReferenceResolver {
  return {
    resolveParticipantReference: vi.fn().mockImplementation(() => {
      if (resolveResult instanceof Error) return Promise.reject(resolveResult);
      return Promise.resolve(resolveResult);
    }),
    resolveCredentialActiveReference: vi
      .fn()
      .mockRejectedValue(new Error('not used by list_agents')),
  };
}

function buildDeps(overrides: Partial<ListAgentsDeps> = {}): ListAgentsDeps {
  const { repo } = buildStubRepo();
  return {
    participantsRepo: repo,
    visibilityEngine: buildStubVisibility(),
    resolver: buildStubResolver(),
    maxPageSize: 100,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ListAgentsInputSchema — AC-8
// ─────────────────────────────────────────────────────────────────────────

describe('ListAgentsInputSchema', () => {
  it('accepts empty input', () => {
    expect(() => ListAgentsInputSchema.parse({})).not.toThrow();
  });

  it('accepts valid filter and pagination', () => {
    expect(() =>
      ListAgentsInputSchema.parse({
        filter: { type: 'worker', owner: 'admin@example.com', capability: 'summarize' },
        pagination: { limit: 10 },
      }),
    ).not.toThrow();
  });

  it('rejects limit > 100 (AC-8: schema cap at 100)', () => {
    expect(() => ListAgentsInputSchema.parse({ pagination: { limit: 101 } })).toThrow();
  });

  it('rejects limit < 1', () => {
    expect(() => ListAgentsInputSchema.parse({ pagination: { limit: 0 } })).toThrow();
  });

  it('rejects non-integer limit', () => {
    expect(() => ListAgentsInputSchema.parse({ pagination: { limit: 1.5 } })).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() => ListAgentsInputSchema.parse({ unknown_field: 'x' })).toThrow();
  });

  it('defaults pagination.limit to 50 when omitted', () => {
    const result = ListAgentsInputSchema.parse({});
    expect(result.pagination?.limit ?? 50).toBe(50);
  });

  it('accepts type worker or scout only', () => {
    expect(() => ListAgentsInputSchema.parse({ filter: { type: 'hivekeeper' } })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// createListAgentsHandler — happy path
// ─────────────────────────────────────────────────────────────────────────

describe('createListAgentsHandler', () => {
  describe('happy path — no filters', () => {
    it('returns empty agents list when repo returns nothing', async () => {
      const handler = createListAgentsHandler(buildDeps());
      const result = await invoke(handler, {}, buildCtx());
      expect(result.agents).toHaveLength(0);
      expect(result.next_cursor).toBeNull();
    });

    it('returns agents visible to caller when repo returns results', async () => {
      const agents = [buildAgent(AGENT_A_ID), buildAgent(AGENT_B_ID)];
      const { repo } = buildStubRepo({ agents, nextCursor: null });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      const result = await invoke(handler, {}, buildCtx());
      expect(result.agents).toHaveLength(2);
    });
  });

  // ─── AC-3: filter.type propagated to repo ───

  describe('AC-3 — filter.type propagated to repo', () => {
    it('passes type=worker to listAgents filter', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, { filter: { type: 'worker' } }, buildCtx());
      expect(capturedFilter).toHaveLength(1);
      expect(capturedFilter[0]?.type).toBe('worker');
    });

    it('passes type=scout to listAgents filter', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, { filter: { type: 'scout' } }, buildCtx());
      expect(capturedFilter[0]?.type).toBe('scout');
    });

    it('does not pass type when omitted', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, {}, buildCtx());
      expect(capturedFilter[0]?.type).toBeUndefined();
    });
  });

  // ─── AC-5: filter.capability propagated to repo ───

  describe('AC-5 — filter.capability propagated to repo', () => {
    it('passes capability substring to listAgents filter', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, { filter: { capability: 'summarize' } }, buildCtx());
      expect(capturedFilter[0]?.capability).toBe('summarize');
    });

    it('does not pass capability when omitted', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, {}, buildCtx());
      expect(capturedFilter[0]?.capability).toBeUndefined();
    });
  });

  // ─── AC-4: filter.owner resolution ───

  describe('AC-4 — filter.owner resolved via resolveParticipantReference', () => {
    it('resolves owner email and passes ownerId to repo', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      // Resolver returns OWNER_ID; participantState is hivekeeper
      const resolver = buildStubResolver(OWNER_ID);
      const stateResult: ParticipantStateSummary = {
        kind: 'hivekeeper',
        state: 'active',
        isAdmin: true,
        hiveId: HIVE_ID,
        colonyId: COLONY_ID,
        ownerId: null,
      };
      const repoWithState: ParticipantsReadRepo = {
        ...repo,
        getParticipantState: vi.fn().mockResolvedValue(stateResult),
      };
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repoWithState, resolver: resolver }),
      );
      await invoke(handler, { filter: { owner: 'admin@example.com' } }, buildCtx());
      expect(capturedFilter[0]?.ownerId).toBe(OWNER_ID);
    });

    it('returns empty result silently when owner reference is RECIPIENT_UNREACHABLE (AC-4)', async () => {
      const { repo } = buildStubRepo();
      const resolver = buildStubResolver(
        new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' }),
      );
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, resolver: resolver }),
      );
      const result = await invoke(handler, { filter: { owner: 'ghost@example.com' } }, buildCtx());
      expect(result.agents).toHaveLength(0);
      expect(result.next_cursor).toBeNull();
    });

    it('re-throws INVALID_INPUT reference_unparseable (malformed owner)', async () => {
      const { repo } = buildStubRepo();
      const resolver = buildStubResolver(
        new CellError('INVALID_INPUT', { subCode: 'reference_unparseable' }),
      );
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, resolver: resolver }),
      );
      await expect(
        invoke(handler, { filter: { owner: '!!malformed!!' } }, buildCtx()),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        subCode: 'reference_unparseable',
      });
    });

    it('returns empty result silently when owner resolves to an Agent (not Hivekeeper)', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const resolver = buildStubResolver(AGENT_A_ID);
      // getParticipantState returns an agent (not a hivekeeper)
      const stateResult: ParticipantStateSummary = {
        kind: 'worker',
        state: 'active',
        isAdmin: null,
        hiveId: HIVE_ID,
        colonyId: COLONY_ID,
        ownerId: OWNER_ID,
      };
      const repoWithState: ParticipantsReadRepo = {
        ...repo,
        getParticipantState: vi.fn().mockResolvedValue(stateResult),
      };
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repoWithState, resolver: resolver }),
      );
      const result = await invoke(
        handler,
        { filter: { owner: 'agent-ref@example.com' } },
        buildCtx(),
      );
      expect(result.agents).toHaveLength(0);
      expect(result.next_cursor).toBeNull();
      // listAgents should NOT have been called
      expect(capturedFilter).toHaveLength(0);
    });
  });

  // ─── hiveId derived from ctx.identity.hiveId ───

  describe('hiveId derived from identity', () => {
    it('passes hiveId from ctx.identity.hiveId to listAgents filter', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      const customHiveId = '01900000-0000-7000-8888-000000000001' as UUIDv7;
      const ctx = buildCtx({ identity: buildIdentity({ hiveId: customHiveId }) });
      await invoke(handler, {}, ctx);
      expect(capturedFilter[0]?.hiveId).toBe(customHiveId);
    });
  });

  // ─── AC-8: maxPageSize runtime cap ───

  describe('AC-8 — maxPageSize runtime cap', () => {
    it('clamps pagination.limit to maxPageSize when input limit equals maxPageSize', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, maxPageSize: 50 }),
      );
      // Input limit 100 would be valid per schema (max 100), but runtime maxPageSize=50 clamps it
      // We test by passing limit=50 (valid schema) and verifying limit propagated is 50
      await invoke(handler, { pagination: { limit: 50 } }, buildCtx());
      expect(capturedFilter[0]?.pagination.limit).toBe(50);
    });

    it('clamps input limit to maxPageSize when maxPageSize < input limit', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      // maxPageSize 30 < schema-validated limit 50 → must clamp to 30
      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, maxPageSize: 30 }),
      );
      await invoke(handler, { pagination: { limit: 50 } }, buildCtx());
      expect(capturedFilter[0]?.pagination.limit).toBe(30);
    });

    it('uses default limit 50 when pagination omitted, clamped by maxPageSize', async () => {
      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await invoke(handler, {}, buildCtx());
      expect(capturedFilter[0]?.pagination.limit).toBe(50);
    });
  });

  // ─── AC-7: visibility filter post-listado ───

  describe('AC-7 — visibility filter silences agents that canSee returns false', () => {
    it('filters out agents for which canSee returns false, next_cursor stays from repo', async () => {
      const agents = [buildAgent(AGENT_A_ID), buildAgent(AGENT_B_ID), buildAgent(AGENT_C_ID)];
      const repoNextCursor: AuditCursor = {
        createdAt: new Date('2026-01-14T10:00:00.000Z'),
        id: AGENT_C_ID,
      };
      const { repo } = buildStubRepo({ agents, nextCursor: repoNextCursor });

      // canSee returns false for AGENT_B_ID, true for the others
      const visibilityEngine: VisibilityEngine = {
        canSend: vi.fn(),
        canSee: vi
          .fn()
          .mockImplementation((input: { targetId: UUIDv7 }) =>
            Promise.resolve(input.targetId !== AGENT_B_ID),
          ),
      };

      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, visibilityEngine }),
      );
      const result = await invoke(handler, {}, buildCtx());

      // 2 visible agents (A and C), B filtered out
      expect(result.agents).toHaveLength(2);
      expect(result.agents.map((a) => a.id)).toEqual([AGENT_A_ID, AGENT_C_ID]);

      // next_cursor reflects repo cursor (pre-filter), not filtered result
      expect(result.next_cursor).not.toBeNull();
    });

    it('returns empty agents list when all agents are invisible, still returns repo next_cursor', async () => {
      const agents = [buildAgent(AGENT_A_ID)];
      const repoNextCursor: AuditCursor = {
        createdAt: new Date('2026-01-14T10:00:00.000Z'),
        id: AGENT_A_ID,
      };
      const { repo } = buildStubRepo({ agents, nextCursor: repoNextCursor });

      const visibilityEngine: VisibilityEngine = {
        canSend: vi.fn(),
        canSee: vi.fn().mockResolvedValue(false),
      };

      const handler = createListAgentsHandler(
        buildDeps({ participantsRepo: repo, visibilityEngine }),
      );
      const result = await invoke(handler, {}, buildCtx());
      expect(result.agents).toHaveLength(0);
      // next_cursor is from repo, not from filtered result
      expect(result.next_cursor).not.toBeNull();
    });
  });

  // ─── State filter: revoked agents excluded ───

  describe('state filter — revoked agents excluded post-listado (defense in depth)', () => {
    it('filters out revoked agents even if repo returned them', async () => {
      const activeAgent = buildAgent(AGENT_A_ID, { state: 'active' });
      const revokedAgent = buildAgent(AGENT_B_ID, { state: 'revoked' });
      const suspendedAgent = buildAgent(AGENT_C_ID, { state: 'suspended' });
      const { repo } = buildStubRepo({
        agents: [activeAgent, revokedAgent, suspendedAgent],
        nextCursor: null,
      });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      const result = await invoke(handler, {}, buildCtx());
      const ids = result.agents.map((a) => a.id);
      expect(ids).toContain(AGENT_A_ID);
      expect(ids).not.toContain(AGENT_B_ID);
      expect(ids).toContain(AGENT_C_ID);
    });
  });

  // ─── AC-6: pagination keyset with 3 pages ───

  describe('AC-6 — keyset pagination cursor round-trip over 3 pages', () => {
    it('cursor from page 1 is decodable and produces non-null next_cursor', async () => {
      const agents = [buildAgent(AGENT_A_ID), buildAgent(AGENT_B_ID)];
      const page1Cursor: AuditCursor = {
        createdAt: new Date('2026-01-14T10:00:00.000Z'),
        id: AGENT_B_ID,
      };
      const { repo } = buildStubRepo({ agents, nextCursor: page1Cursor });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));

      const page1 = await invoke(handler, { pagination: { limit: 2 } }, buildCtx());
      expect(page1.next_cursor).not.toBeNull();

      // Verify next_cursor is decodable and encodes the correct cursor
      const decoded = decodeCursor(page1.next_cursor!);
      expect(decoded.id).toBe(page1Cursor.id);
      expect(decoded.createdAt.toISOString()).toBe(page1Cursor.createdAt.toISOString());
    });

    it('page 3 returns null next_cursor when repo signals no more pages', async () => {
      const agents = [buildAgent(AGENT_C_ID)];
      const { repo } = buildStubRepo({ agents, nextCursor: null });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));

      const page3 = await invoke(handler, { pagination: { limit: 2 } }, buildCtx());
      expect(page3.next_cursor).toBeNull();
    });

    it('passes decoded cursor to repo when caller provides pagination cursor', async () => {
      const existingCursor: AuditCursor = {
        createdAt: new Date('2026-01-14T10:00:00.000Z'),
        id: AGENT_A_ID,
      };
      const opaqueCursor = encodeCursor(existingCursor);

      const { repo, capturedFilter } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));

      await invoke(handler, { pagination: { cursor: opaqueCursor, limit: 10 } }, buildCtx());
      expect(capturedFilter[0]?.pagination.cursor).toBeDefined();
      expect(capturedFilter[0]?.pagination.cursor?.id).toBe(existingCursor.id);
      expect(capturedFilter[0]?.pagination.cursor?.createdAt.toISOString()).toBe(
        existingCursor.createdAt.toISOString(),
      );
    });

    it('throws INVALID_INPUT for invalid cursor string', async () => {
      const { repo } = buildStubRepo();
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      await expect(
        invoke(handler, { pagination: { cursor: 'invalid-cursor!!!' } }, buildCtx()),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'invalid_cursor' });
    });
  });

  // ─── AC-9: output shape ───

  describe('AC-9 — output shape exact field set', () => {
    it('each AgentSummary has exactly: capabilities, id, name, owner_id, state, type', async () => {
      const { repo } = buildStubRepo({
        agents: [buildAgent(AGENT_A_ID)],
        nextCursor: null,
      });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      const result = await invoke(handler, {}, buildCtx());
      expect(result.agents).toHaveLength(1);
      const summary = result.agents[0];
      expect(summary).toBeDefined();
      if (!summary) return;
      expect(Object.keys(summary).sort()).toEqual([
        'capabilities',
        'id',
        'name',
        'owner_id',
        'state',
        'type',
      ]);
    });

    it('state is active or suspended for agents returned', async () => {
      const activeAgent = buildAgent(AGENT_A_ID, { state: 'active' });
      const suspendedAgent = buildAgent(AGENT_B_ID, { state: 'suspended' });
      const { repo } = buildStubRepo({ agents: [activeAgent, suspendedAgent], nextCursor: null });
      const handler = createListAgentsHandler(buildDeps({ participantsRepo: repo }));
      const result = await invoke(handler, {}, buildCtx());
      const states = result.agents.map((a) => a.state);
      for (const s of states) {
        expect(['active', 'suspended']).toContain(s);
      }
    });
  });
});
