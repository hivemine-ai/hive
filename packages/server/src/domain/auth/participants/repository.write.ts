// Participants repository — write functions for Slice 0 (Hitos 15-18).
// Read functions live in repository.ts and are exposed via createParticipantsReadRepo.
// `listAgents` was relocated to repository.ts in PRY-029 — it does not require an
// admin caller and is consumed by the read-only MCP `list_agents` tool.
//
// Per ADR-007: every admin operation accepts `caller: CallerContext`. The auth check
// (admin flag) is delegated to requireAdminCaller; domain invariants are enforced ALWAYS.

import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import {
  boolToInt,
  dateToIso,
  intToBool,
  jsonParse,
  jsonStringify,
} from '#persistence/type-mappers.js';
import type { AgentsTable, Database, HivekeepersTable } from '#persistence/schema.js';
import { requireAdminCaller, type CallerContext } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { UUIDv7 } from '../types.js';

import type { Agent, Hivekeeper } from './entities.js';
import { noopCellsHook, type CellsRepoHook } from './cells-hook.js';
import type { AuditCursor } from './repository.js';

// ---------- Shared mappers (kept local to the write module to avoid circular import) ----------

function rowToHivekeeper(row: Selectable<HivekeepersTable>): Hivekeeper {
  return {
    id: row.id,
    hiveId: row.hive_id,
    colonyId: row.colony_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: intToBool(row.is_admin),
    state: row.state,
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function rowToAgent(row: Selectable<AgentsTable>): Agent {
  return {
    id: row.id,
    hiveId: row.hive_id,
    colonyId: row.colony_id,
    ownerId: row.owner_id,
    name: row.name,
    type: row.type,
    capabilities: jsonParse<string[]>(row.capabilities),
    instructions: row.instructions,
    state: row.state,
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

// ---------- Public input/output types ----------

export interface CreateHivekeeperInput {
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  email: string;
  displayName?: string;
  isAdmin?: boolean;
}

export interface CreateAgentInput {
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  ownerId: UUIDv7;
  name: string;
  type: 'worker' | 'scout';
  capabilities?: string[];
  instructions?: string;
}

// Cap on the capabilities array per the tech spec (64 elements × 128 chars each).
const CAPABILITIES_MAX_ELEMENTS = 64;
const CAPABILITY_MAX_LENGTH = 128;

export interface ListHivekeepersFilter {
  hiveId: UUIDv7;
  state?: 'active' | 'revoked';
  isAdmin?: boolean;
  pagination: { cursor: AuditCursor | null; limit: number };
}

export interface ListHivekeepersResult {
  hivekeepers: Hivekeeper[];
  nextCursor: AuditCursor | null;
}

// ---------- Repository factory ----------

export interface RevokeHivekeeperResult {
  revokedAgentIds: UUIDv7[];
  closedCellIds: UUIDv7[];
}

export interface ParticipantsWriteRepo {
  createHivekeeper(input: CreateHivekeeperInput, caller: CallerContext): Promise<Hivekeeper>;
  createAgent(input: CreateAgentInput, caller: CallerContext): Promise<Agent>;
  revokeAgent(id: UUIDv7, caller: CallerContext): Promise<void>;
  /**
   * Revoke a Hivekeeper and cascade-revoke all owned Agents + close their Cells in
   * the same transaction. Snapshots the effective retention policy on the keeper's
   * row so post-revocation reads see frozen retention semantics. Idempotent: a
   * second invocation on an already-revoked keeper returns empty counts without
   * error.
   */
  revokeHivekeeperWithCascade(id: UUIDv7, caller: CallerContext): Promise<RevokeHivekeeperResult>;
  listHivekeepers(filter: ListHivekeepersFilter): Promise<ListHivekeepersResult>;
}

export interface ParticipantsWriteRepoOptions {
  // Cap server-side for `listHivekeepers`. Defaults to 200.
  listMaxPageSize?: number;
  // Cross-domain hook into Cell Store. In Slice 0 (PRY-002), defaults to noopCellsHook;
  // PRY-003 will wire the real one at composition root.
  cellsHook?: CellsRepoHook;
  // Injectable clock for tests.
  now?: () => Date;
}

export function createParticipantsWriteRepo(
  db: Kysely<Database>,
  opts: ParticipantsWriteRepoOptions = {},
): ParticipantsWriteRepo {
  const listMaxPageSize = opts.listMaxPageSize ?? 200;
  const cellsHook = opts.cellsHook ?? noopCellsHook;
  const clock = opts.now ?? (() => new Date());

  return {
    async createHivekeeper(input, caller): Promise<Hivekeeper> {
      requireAdminCaller(caller);

      const id = uuidv7();
      const now = clock();

      return await db.transaction().execute<Hivekeeper>(async (tx) => {
        try {
          await tx
            .insertInto('hivekeepers')
            .values({
              id,
              hive_id: input.hiveId,
              colony_id: input.colonyId,
              email: input.email,
              display_name: input.displayName ?? null,
              is_admin: boolToInt(input.isAdmin ?? false),
              state: 'active',
              created_at: dateToIso(now),
              revoked_at: null,
            })
            .execute();
        } catch (err) {
          throw mapInsertError(err, 'hivekeeper');
        }

        // Cross-domain hook (no-op stub in PRY-002; real adapter wired in PRY-003).
        // The cell write participates in this TX → atomicity invariant: if the cell
        // insert fails the hivekeeper INSERT is rolled back.
        await cellsHook.createCell(tx, {
          ownerId: id,
          ownerKind: 'hivekeeper',
          hiveId: input.hiveId,
          colonyId: input.colonyId,
        });

        const row = await tx
          .selectFrom('hivekeepers')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return rowToHivekeeper(row);
      });
    },

    async createAgent(input, caller): Promise<Agent> {
      requireAdminCaller(caller);
      validateCapabilities(input.capabilities ?? []);

      const id = uuidv7();
      const now = clock();
      const capabilities = input.capabilities ?? [];

      const result = await db.transaction().execute<Agent>(async (tx) => {
        try {
          await tx
            .insertInto('agents')
            .values({
              id,
              hive_id: input.hiveId,
              colony_id: input.colonyId,
              owner_id: input.ownerId,
              name: input.name,
              type: input.type,
              capabilities: jsonStringify(capabilities),
              instructions: input.instructions ?? '',
              state: 'active',
              created_at: dateToIso(now),
              revoked_at: null,
            })
            .execute();
        } catch (err) {
          throw mapInsertError(err, 'agent');
        }

        // Cross-domain hook (no-op stub in PRY-002; real impl in PRY-003).
        await cellsHook.createCell(tx, {
          ownerId: id,
          ownerKind: 'agent',
          hiveId: input.hiveId,
          colonyId: input.colonyId,
        });

        const row = await tx
          .selectFrom('agents')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return rowToAgent(row);
      });

      return result;
    },

    async revokeAgent(id, caller): Promise<void> {
      requireAdminCaller(caller);

      await db.transaction().execute(async (tx) => {
        // Defense in depth: ensure target is an Agent, not a Hivekeeper.
        const hk = await tx
          .selectFrom('hivekeepers')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();
        if (hk) {
          throw new AuthError('INVALID_STATE_TRANSITION', {
            subCode: 'target_is_hivekeeper',
            message: 'revokeAgent cannot target a Hivekeeper',
          });
        }

        const row = await tx
          .selectFrom('agents')
          .select(['id', 'state', 'hive_id', 'colony_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row) {
          // Caller asked to revoke an unknown id. Treat as no-op idempotent (no Agent to revoke).
          return;
        }
        if (row.state === 'revoked') {
          // Idempotent.
          return;
        }

        const now = clock();
        await tx
          .updateTable('agents')
          .set({ state: 'revoked', revoked_at: dateToIso(now) })
          .where('id', '=', id)
          .execute();

        await cellsHook.closeCell(tx, { ownerId: id });
      });
    },

    async revokeHivekeeperWithCascade(id, caller): Promise<RevokeHivekeeperResult> {
      const adminIdentity = requireAdminCaller(caller);
      const setBy = adminIdentity?.participantId ?? null;

      return await db.transaction().execute<RevokeHivekeeperResult>(async (tx) => {
        // Defense in depth: ensure target is a Hivekeeper, not an Agent.
        // Mirrors the symmetric guard in revokeAgent.
        const ag = await tx
          .selectFrom('agents')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();
        if (ag) {
          throw new AuthError('INVALID_STATE_TRANSITION', {
            subCode: 'target_is_agent',
            message: 'revokeHivekeeperWithCascade cannot target an Agent',
          });
        }

        const now = clock();

        // Atomic UPDATE … WHERE state='active' RETURNING — eliminates the SELECT-then-UPDATE
        // race and gives us idempotency for free (already-revoked or unknown id → empty result).
        const keeperRow = await tx
          .updateTable('hivekeepers')
          .set({ state: 'revoked', revoked_at: dateToIso(now) })
          .where('id', '=', id)
          .where('state', '=', 'active')
          .returning(['id', 'hive_id'])
          .executeTakeFirst();
        if (!keeperRow) {
          // Either the keeper doesn't exist OR is already revoked. Idempotent return.
          return { revokedAgentIds: [], closedCellIds: [] };
        }
        const hiveId = keeperRow.hive_id;

        // Cascade-revoke owned agents that are still active.
        const revokedAgents = await tx
          .updateTable('agents')
          .set({ state: 'revoked', revoked_at: dateToIso(now) })
          .where('owner_id', '=', id)
          .where('state', '=', 'active')
          .returning('id')
          .execute();
        const revokedAgentIds = revokedAgents.map((r) => r.id);

        // Cross-domain cascade: close the keeper's Cell + all owned agents' Cells.
        // The cellsHook participates in this same TX → atomicity invariant: if the
        // hook throws, the keeper + agent UPDATEs are rolled back.
        await cellsHook.closeCell(tx, { ownerId: id });
        await cellsHook.closeCellsByOwner(tx, { ownerIds: revokedAgentIds });

        // Snapshot the effective retention policy at revocation time per Cell Store
        // tech spec line 481. Two cases:
        //   (a) The keeper has an explicit override — UPDATE its frozen_at.
        //   (b) The keeper has no override — INSERT a snapshot of the hive default.
        // If the hive itself has no default policy yet (Slice 1+ admin op), the
        // INSERT inserts zero rows (SELECT returns empty); we accept this silently
        // because cascade correctness does not depend on the snapshot. The next
        // boot reconciliation sweep (deferred to Slice 1+) will catch up.
        const snapshotIso = dateToIso(now);
        const updatedPolicy = await tx
          .updateTable('retention_policies')
          .set({ frozen_at: snapshotIso })
          .where('scope', '=', 'hivekeeper')
          .where('scope_id', '=', id)
          .where('frozen_at', 'is', null)
          .returning('id')
          .execute();

        if (updatedPolicy.length === 0) {
          const defaults = await tx
            .selectFrom('retention_policies')
            .select(['unread_retention_ms', 'read_retention_ms'])
            .where('scope', '=', 'hive')
            .where('hive_id', '=', hiveId)
            .executeTakeFirst();
          if (defaults) {
            // The retention_policies UNIQUE constraint on (hive_id, scope_id) is a
            // partial index (WHERE scope='hivekeeper'). Kysely's `onConflict()`
            // inference doesn't match partial indexes uniformly across SQLite and
            // Postgres, so we use try/catch on UNIQUE instead — portable and
            // explicit. v0.1 admin ops are single-writer (PRY-010 risk #5), so the
            // race is bounded; if it loses we accept silently — the concurrent
            // override row exists and a subsequent revoke can update its frozen_at.
            try {
              await tx
                .insertInto('retention_policies')
                .values({
                  id: uuidv7(),
                  hive_id: hiveId,
                  scope: 'hivekeeper',
                  scope_id: id,
                  unread_retention_ms: defaults.unread_retention_ms,
                  read_retention_ms: defaults.read_retention_ms,
                  frozen_at: snapshotIso,
                  set_by: setBy,
                })
                .execute();
            } catch (err) {
              if (!(err instanceof Error && /UNIQUE/i.test(err.message))) {
                throw err;
              }
            }
          }
        }

        // Collect the cells closed by THIS cascade (not pre-existing closed cells).
        // The hook methods are void-returning, so we re-query — but filter by
        // `closed_at >= snapshotIso` so an Agent that was previously revoked
        // individually (and whose Cell was already 'closed' before this call) does
        // NOT inflate the count. Contract: closedCellIds == cells this call closed.
        const closedRows = await tx
          .selectFrom('cells')
          .select('id')
          .where('owner_id', 'in', [id, ...revokedAgentIds])
          .where('state', '=', 'closed')
          .where('closed_at', '>=', snapshotIso)
          .execute();

        return {
          revokedAgentIds,
          closedCellIds: closedRows.map((r) => r.id),
        };
      });
    },

    async listHivekeepers(filter): Promise<ListHivekeepersResult> {
      const limit = Math.min(filter.pagination.limit, listMaxPageSize);

      let query = db.selectFrom('hivekeepers').selectAll().where('hive_id', '=', filter.hiveId);
      if (filter.state !== undefined) {
        query = query.where('state', '=', filter.state);
      }
      if (filter.isAdmin !== undefined) {
        query = query.where('is_admin', '=', boolToInt(filter.isAdmin));
      }
      if (filter.pagination.cursor) {
        const cursorIso = dateToIso(filter.pagination.cursor.createdAt);
        const cursorId = filter.pagination.cursor.id;
        query = query.where((eb) =>
          eb.or([
            eb('created_at', '<', cursorIso),
            eb.and([eb('created_at', '=', cursorIso), eb('id', '<', cursorId)]),
          ]),
        );
      }
      query = query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);

      const rows = await query.execute();
      const hasMore = rows.length > limit;
      const trimmed = hasMore ? rows.slice(0, limit) : rows;
      const hivekeepers = trimmed.map(rowToHivekeeper);
      const last = hivekeepers.at(-1);
      const nextCursor: AuditCursor | null =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { hivekeepers, nextCursor };
    },
  };
}

function validateCapabilities(caps: string[]): void {
  if (caps.length > CAPABILITIES_MAX_ELEMENTS) {
    throw new AuthError('INVALID_STATE_TRANSITION', {
      subCode: 'capabilities_too_many',
      message: `capabilities exceeds ${CAPABILITIES_MAX_ELEMENTS} elements`,
    });
  }
  for (const c of caps) {
    if (c.length > CAPABILITY_MAX_LENGTH) {
      throw new AuthError('INVALID_STATE_TRANSITION', {
        subCode: 'capability_too_long',
        message: `capability '${c.slice(0, 32)}…' exceeds ${CAPABILITY_MAX_LENGTH} chars`,
      });
    }
  }
}

function mapInsertError(err: unknown, kind: 'hivekeeper' | 'agent'): AuthError {
  // SQLite throws SqliteError with code 'SQLITE_CONSTRAINT'; pg throws with code '23505' etc.
  // Both produce a message containing "UNIQUE" for unique-constraint violations.
  if (err instanceof Error && /UNIQUE/i.test(err.message)) {
    return new AuthError('INVALID_STATE_TRANSITION', {
      subCode: kind === 'hivekeeper' ? 'email_already_used' : 'agent_name_taken',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new AuthError('INVALID_STATE_TRANSITION', {
      subCode: 'insert_failed',
      message: err.message,
      cause: err,
    });
  }
  return new AuthError('INVALID_STATE_TRANSITION', { subCode: 'insert_failed' });
}
