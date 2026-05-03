import { z } from 'zod';

import { isCellError } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';
import type { UUIDv7 } from '#domain/auth/index.js';

import type { RequestContext } from '../types.js';
import type { ReferenceResolver } from '../reference-resolver.js';
import { adaptAgentList, decodeCursor } from '#transport/mcp/views/agent-list-view.js';
import type { AgentListView } from '#transport/mcp/views/agent-list-view.js';

// Schema max cap is a compile-time literal that matches the default env var value.
// The runtime maxPageSize (from ListAgentsDeps) is the authoritative cap — it may
// be lower if the operator configures HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE to a
// smaller value. The schema is defense layer 1; the handler clamp is defense layer 2.
const SCHEMA_MAX_PAGE_SIZE = 100;

export const ListAgentsInputSchema = z
  .object({
    filter: z
      .object({
        type: z.enum(['worker', 'scout']).optional(),
        owner: z.string().optional(),
        capability: z.string().optional(),
      })
      .optional(),
    pagination: z
      .object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(SCHEMA_MAX_PAGE_SIZE).default(50),
      })
      .optional(),
  })
  .strict();

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;

export interface ListAgentsDeps {
  participantsRepo: ParticipantsReadRepo;
  visibilityEngine: VisibilityEngine;
  resolver: ReferenceResolver;
  /**
   * Hard cap from env (default 100). Schema enforces same as compile-time literal;
   * this runtime value is the authoritative cap — used to clamp pagination.limit.
   */
  maxPageSize: number;
}

export function createListAgentsHandler(deps: ListAgentsDeps) {
  return async function listAgents(
    input: ListAgentsInput,
    ctx: RequestContext,
  ): Promise<AgentListView> {
    // Step 1: Input is already parsed by the catalog wrapper (matches the
    // convention of all 6 other tools — schema parse happens at the catalog
    // boundary).

    // Step 2: Decode cursor if present
    const cursor =
      input.pagination?.cursor !== undefined ? decodeCursor(input.pagination.cursor) : null;

    // Step 3: Resolve owner if filter.owner is present
    let ownerId: UUIDv7 | undefined;
    if (input.filter?.owner !== undefined) {
      try {
        const resolved = await deps.resolver.resolveParticipantReference(
          input.filter.owner,
          ctx.identity,
        );
        // Defense check: resolved participant must be a Hivekeeper, not an Agent.
        // Per product Tool 6: filter.owner refers to a Hivekeeper.
        const state = await deps.participantsRepo.getParticipantState(resolved);
        if (state === null || state.kind !== 'hivekeeper') {
          return { agents: [], next_cursor: null };
        }
        ownerId = resolved;
      } catch (err) {
        if (
          isCellError(err) &&
          err.code === 'RECIPIENT_UNREACHABLE' &&
          err.subCode === 'reference_unresolved'
        ) {
          // Owner not found or not visible — silent empty result per product Tool 6
          return { agents: [], next_cursor: null };
        }
        // INVALID_INPUT (reference_unparseable) or any other error — re-throw
        throw err;
      }
    }

    // Step 4: Derive hiveId from caller identity
    const hiveId = ctx.identity.hiveId;

    // Step 5: Call repo with clamped limit and filters
    const limit = Math.min(input.pagination?.limit ?? 50, deps.maxPageSize);

    // exactOptionalPropertyTypes: build filter incrementally to avoid assigning
    // `undefined` to optional fields (per lesson PRY-002/004).
    const repoFilter: Parameters<typeof deps.participantsRepo.listAgents>[0] = {
      hiveId,
      // Do not pass state to the repo — we want both 'active' and 'suspended'.
      // Revoked agents are excluded post-fetch in Step 6 (defense in depth),
      // since the repo returns all states when state filter is absent.
      pagination: { cursor, limit },
    };
    if (ownerId !== undefined) repoFilter.ownerId = ownerId;
    if (input.filter?.type !== undefined) repoFilter.type = input.filter.type;
    if (input.filter?.capability !== undefined) repoFilter.capability = input.filter.capability;

    const repoResult = await deps.participantsRepo.listAgents(repoFilter);

    // Step 6: Post-filter: exclude revoked agents (defense in depth) then apply visibility
    const visibleAgents = await (async () => {
      const nonRevoked = repoResult.agents.filter((a) => a.state !== 'revoked');
      const results = await Promise.all(
        nonRevoked.map((agent) =>
          deps.visibilityEngine
            .canSee({ callerContext: ctx.identity, targetId: agent.id, requestId: ctx.requestId })
            .then((visible) => ({ agent, visible })),
        ),
      );
      return results.filter((r) => r.visible).map((r) => r.agent);
    })();

    // Step 7 + 8: Project surviving agents and encode next_cursor.
    // next_cursor reflects the repo's pagination (pre-visibility-filter) — a page
    // may have fewer items than limit after filtering; caller must paginate until
    // next_cursor === null.
    return adaptAgentList({ agents: visibleAgents, nextCursor: repoResult.nextCursor });
  };
}
