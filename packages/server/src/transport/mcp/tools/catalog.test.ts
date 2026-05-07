// Guardrail tests for the MCP tool catalog: every user-facing string
// (`title`, `description`) emitted to MCP clients must be free of
// internal references that leak project-management vocabulary into the
// product surface. Concretely, anything matching `PRY-\d+` is internal
// (vault project IDs) and must NOT appear in tool metadata that ends
// up in `tools/list` responses or third-party MCP UIs.
//
// This guard exists because PRY-068 found that an external tester
// produced a tool catalog table referencing `(PRY-028)`, `(PRY-029)`,
// `(PRY-030)` — those refs only live in source-code comments today,
// but a future reviewer pasting from internal docs into a description
// would silently leak. CI catches it here.

import { describe, expect, it } from 'vitest';

import { createToolCatalog, type ToolCatalogDeps, type ToolDefinition } from './catalog.js';

// Minimal stub: `createToolCatalog` only USES the deps inside the
// handlers it constructs. The descriptive metadata (`title`,
// `description`) is hard-coded in the catalog factory and does not
// touch deps. So we can hand a cast of `{}` and pull only the
// metadata for assertions.
function buildCatalogForMetadata(): ToolDefinition[] {
  return createToolCatalog({} as unknown as ToolCatalogDeps);
}

const PRY_REF = /PRY-\d+/;
const SLICE_REF = /\bSlice\s+\d+\b/i;
const ADR_REF = /\bADR-\d+\b/;
const INC_REF = /\bINC-\d{4}-\d+\b/;

describe('MCP tool catalog metadata — no internal refs leak to user-facing strings', () => {
  it('exposes 8 tools (Slice 0 + Slice 2 catalog complete per v0.1)', () => {
    const catalog = buildCatalogForMetadata();
    expect(catalog.map((t) => t.name)).toEqual([
      'get_agent_config',
      'send_message',
      'reply_to',
      'read_mailbox',
      'mark_read',
      'check_unread_messages',
      'list_agents',
      'get_agent_status',
    ]);
  });

  it('every tool has a non-empty title and description', () => {
    for (const tool of buildCatalogForMetadata()) {
      expect(tool.title.length, `tool ${tool.name} missing title`).toBeGreaterThan(0);
      expect(tool.description.length, `tool ${tool.name} missing description`).toBeGreaterThan(0);
    }
  });

  it('no tool description references a vault PRY id (PRY-NNN)', () => {
    for (const tool of buildCatalogForMetadata()) {
      expect(
        tool.description,
        `tool '${tool.name}' description must not reference PRY-NNN — internal vault metadata leaking to MCP clients`,
      ).not.toMatch(PRY_REF);
    }
  });

  it('no tool title references a vault PRY id (PRY-NNN)', () => {
    for (const tool of buildCatalogForMetadata()) {
      expect(
        tool.title,
        `tool '${tool.name}' title must not reference PRY-NNN — internal vault metadata leaking to MCP clients`,
      ).not.toMatch(PRY_REF);
    }
  });

  it('no tool description references a Slice / ADR / Incident id', () => {
    for (const tool of buildCatalogForMetadata()) {
      const desc = tool.description;
      expect(desc, `tool '${tool.name}' description must not reference Slice N`).not.toMatch(
        SLICE_REF,
      );
      expect(desc, `tool '${tool.name}' description must not reference ADR-NNN`).not.toMatch(
        ADR_REF,
      );
      expect(desc, `tool '${tool.name}' description must not reference INC-YYYY-NNN`).not.toMatch(
        INC_REF,
      );
    }
  });
});
