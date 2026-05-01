import { CellError } from '#domain/cells/index.js';
import type { Agent, AuditCursor } from '#domain/auth/index.js';

// UUID v7 shape: 8-4-4-4-12 hex, version nibble must be 7, variant bits [89ab].
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentSummary {
  id: string;
  name: string;
  type: 'worker' | 'scout';
  owner_id: string;
  state: 'active' | 'suspended';
  capabilities: string[];
}

export interface AgentListView {
  agents: AgentSummary[];
  next_cursor: string | null;
}

/**
 * Serializes an AuditCursor to an opaque base64url string.
 * Format: base64url(JSON.stringify({ c: createdAt.toISOString(), i: id }))
 */
export function encodeCursor(cursor: AuditCursor): string {
  const payload = JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Deserializes an opaque base64url string back to an AuditCursor.
 * Throws CellError('INVALID_INPUT', { subCode: 'invalid_cursor' }) on any failure:
 * non-base64url, invalid JSON, missing fields, invalid Date, invalid id shape.
 */
export function decodeCursor(opaque: string): AuditCursor {
  let raw: string;
  try {
    raw = Buffer.from(opaque, 'base64url').toString('utf8');
  } catch {
    throw new CellError('INVALID_INPUT', { subCode: 'invalid_cursor' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CellError('INVALID_INPUT', { subCode: 'invalid_cursor' });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('c' in parsed) ||
    !('i' in parsed) ||
    typeof (parsed as Record<string, unknown>).c !== 'string' ||
    typeof (parsed as Record<string, unknown>).i !== 'string'
  ) {
    throw new CellError('INVALID_INPUT', { subCode: 'invalid_cursor' });
  }

  const { c, i } = parsed as { c: string; i: string };

  const createdAt = new Date(c);
  if (isNaN(createdAt.getTime())) {
    throw new CellError('INVALID_INPUT', { subCode: 'invalid_cursor' });
  }

  if (!UUID_V7_RE.test(i)) {
    throw new CellError('INVALID_INPUT', { subCode: 'invalid_cursor' });
  }

  return { createdAt, id: i };
}

function projectAgent(agent: Agent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    owner_id: agent.ownerId,
    // The handler post-filters `revoked` before calling this adapter, so the
    // narrow is a defense-in-depth assert: a revoked agent reaching projection
    // is a bug upstream, not a wire-shape question. Throwing here surfaces it
    // loudly rather than silently relabelling state on the wire (PRY-030 N1
    // resolution: replaces the prior `as 'active' | 'suspended'` escape hatch).
    state: assertWireState(agent.state),
    capabilities: agent.capabilities,
  };
}

function assertWireState(state: Agent['state']): 'active' | 'suspended' {
  if (state === 'active' || state === 'suspended') return state;
  throw new CellError('INVALID_INPUT', { subCode: 'agent_revoked_in_projection' });
}

/**
 * Projects repo ListAgentsResult to the wire AgentListView shape.
 * Cursor encoding is handled here — the handler never touches cursor serialization directly.
 */
export function adaptAgentList(result: {
  agents: Agent[];
  nextCursor: AuditCursor | null;
}): AgentListView {
  return {
    agents: result.agents.map(projectAgent),
    next_cursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
  };
}
