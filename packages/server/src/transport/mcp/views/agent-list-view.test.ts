import { describe, expect, it } from 'vitest';

import { CellError } from '#domain/cells/index.js';
import type { AuditCursor } from '#domain/auth/index.js';
import type { Agent } from '#domain/auth/index.js';
import type { UUIDv7 } from '#domain/auth/index.js';

import { adaptAgentList, encodeCursor, decodeCursor } from './agent-list-view.js';

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

const AGENT_ID = '01900000-0000-7000-8000-000000000001' as UUIDv7;
const OWNER_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const HIVE_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const COLONY_ID = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const FIXED_DATE = new Date('2026-01-15T10:00:00.000Z');

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId: OWNER_ID,
    name: 'test-worker',
    type: 'worker',
    capabilities: ['summarize', 'translate'],
    instructions: 'You are a test worker.',
    state: 'active',
    createdAt: FIXED_DATE,
    revokedAt: null,
    ...overrides,
  };
}

const FIXED_CURSOR: AuditCursor = {
  createdAt: FIXED_DATE,
  id: AGENT_ID,
};

// ─────────────────────────────────────────────────────────────────────────
// encodeCursor / decodeCursor
// ─────────────────────────────────────────────────────────────────────────

describe('encodeCursor', () => {
  it('returns an opaque base64url string', () => {
    const encoded = encodeCursor(FIXED_CURSOR);
    expect(typeof encoded).toBe('string');
    // base64url chars only — no `+`, `/`, `=`
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(encodeCursor(FIXED_CURSOR)).toBe(encodeCursor(FIXED_CURSOR));
  });
});

describe('decodeCursor', () => {
  it('round-trips: decodeCursor(encodeCursor(c)) equals c', () => {
    const encoded = encodeCursor(FIXED_CURSOR);
    const decoded = decodeCursor(encoded);
    expect(decoded.id).toBe(FIXED_CURSOR.id);
    expect(decoded.createdAt.toISOString()).toBe(FIXED_CURSOR.createdAt.toISOString());
  });

  it('throws INVALID_INPUT with subCode invalid_cursor for malformed base64', () => {
    expect(() => decodeCursor('not valid base64!!!')).toThrow(CellError);
    try {
      decodeCursor('not valid base64!!!');
    } catch (err) {
      expect(err).toBeInstanceOf(CellError);
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });

  it('throws INVALID_INPUT for valid base64url of invalid JSON', () => {
    const badPayload = Buffer.from('not json', 'utf8').toString('base64url');
    expect(() => decodeCursor(badPayload)).toThrow(CellError);
    try {
      decodeCursor(badPayload);
    } catch (err) {
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });

  it('throws INVALID_INPUT when JSON is missing the c field', () => {
    const payload = Buffer.from(JSON.stringify({ i: AGENT_ID }), 'utf8').toString('base64url');
    expect(() => decodeCursor(payload)).toThrow(CellError);
    try {
      decodeCursor(payload);
    } catch (err) {
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });

  it('throws INVALID_INPUT when JSON is missing the i field', () => {
    const payload = Buffer.from(JSON.stringify({ c: FIXED_DATE.toISOString() }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrow(CellError);
    try {
      decodeCursor(payload);
    } catch (err) {
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });

  it('throws INVALID_INPUT when c is not a valid ISO date string', () => {
    const payload = Buffer.from(JSON.stringify({ c: 'not-a-date', i: AGENT_ID }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrow(CellError);
    try {
      decodeCursor(payload);
    } catch (err) {
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });

  it('throws INVALID_INPUT when i is not a UUIDv7-shaped string', () => {
    const payload = Buffer.from(
      JSON.stringify({ c: FIXED_DATE.toISOString(), i: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(payload)).toThrow(CellError);
    try {
      decodeCursor(payload);
    } catch (err) {
      const cellErr = err as CellError;
      expect(cellErr.code).toBe('INVALID_INPUT');
      expect(cellErr.subCode).toBe('invalid_cursor');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// adaptAgentList — projection and wire shape
// ─────────────────────────────────────────────────────────────────────────

describe('adaptAgentList', () => {
  it('projects a single active worker to the correct AgentSummary fields', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: null });
    expect(result.agents).toHaveLength(1);
    const summary = result.agents[0];
    expect(summary).toBeDefined();
    if (!summary) return;
    expect(summary.id).toBe(AGENT_ID);
    expect(summary.name).toBe('test-worker');
    expect(summary.type).toBe('worker');
    expect(summary.owner_id).toBe(OWNER_ID);
    expect(summary.state).toBe('active');
    expect(summary.capabilities).toEqual(['summarize', 'translate']);
  });

  it('output shape has exactly the fields: capabilities, id, name, owner_id, state, type (AC-9)', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: null });
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

  it('excludes instructions, revokedAt, createdAt, hiveId, colonyId from projection', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: null });
    const summary = result.agents[0] as unknown as Record<string, unknown>;
    expect(summary).not.toHaveProperty('instructions');
    expect(summary).not.toHaveProperty('revokedAt');
    expect(summary).not.toHaveProperty('createdAt');
    expect(summary).not.toHaveProperty('hiveId');
    expect(summary).not.toHaveProperty('colonyId');
  });

  it('projects a suspended scout correctly', () => {
    const agent = buildAgent({
      type: 'scout',
      state: 'suspended',
      capabilities: ['search'],
    });
    const result = adaptAgentList({ agents: [agent], nextCursor: null });
    const summary = result.agents[0];
    expect(summary).toBeDefined();
    if (!summary) return;
    expect(summary.type).toBe('scout');
    expect(summary.state).toBe('suspended');
    expect(summary.capabilities).toEqual(['search']);
  });

  it('returns next_cursor as opaque string when nextCursor is non-null', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: FIXED_CURSOR });
    expect(typeof result.next_cursor).toBe('string');
    expect(result.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns next_cursor as null when nextCursor is null', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: null });
    expect(result.next_cursor).toBeNull();
  });

  it('encodes next_cursor that round-trips back to the original AuditCursor', () => {
    const result = adaptAgentList({ agents: [buildAgent()], nextCursor: FIXED_CURSOR });
    const opaque = result.next_cursor;
    expect(opaque).not.toBeNull();
    const decoded = decodeCursor(opaque!);
    expect(decoded.id).toBe(FIXED_CURSOR.id);
    expect(decoded.createdAt.toISOString()).toBe(FIXED_CURSOR.createdAt.toISOString());
  });

  it('handles an empty agents array', () => {
    const result = adaptAgentList({ agents: [], nextCursor: null });
    expect(result.agents).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
  });

  it('projects multiple agents in order', () => {
    const agent1 = buildAgent({ id: '01900000-0000-7000-8000-000000000001', name: 'a1' });
    const agent2 = buildAgent({ id: '01900000-0000-7000-8000-000000000002', name: 'a2' });
    const result = adaptAgentList({ agents: [agent1, agent2], nextCursor: null });
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]?.name).toBe('a1');
    expect(result.agents[1]?.name).toBe('a2');
  });
});
