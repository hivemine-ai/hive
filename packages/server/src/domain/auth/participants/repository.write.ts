// Participants repository — write functions for Slice 0 (Hitos 15-18).
// Read functions live in repository.ts and are exposed via createParticipantsReadRepo.
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
} from '../../../persistence/type-mappers.js';
import type { AgentsTable, Database, HivekeepersTable } from '../../../persistence/schema.js';
import { requireAdminCaller, type CallerContext } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { ParticipantState, UUIDv7 } from '../types.js';

import type { Agent, Hivekeeper } from './entities.js';
import { noopCellsHook, type CellsRepoHook } from './cells-hook.js';

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

export interface AuditCursor {
  createdAt: Date;
  id: UUIDv7;
}

export interface ListAgentsFilter {
  hiveId: UUIDv7;
  ownerId?: UUIDv7;
  type?: 'worker' | 'scout';
  state?: ParticipantState;
  pagination: { cursor: AuditCursor | null; limit: number };
}

export interface ListAgentsResult {
  agents: Agent[];
  nextCursor: AuditCursor | null;
}

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

export interface ParticipantsWriteRepo {
  createHivekeeper(input: CreateHivekeeperInput, caller: CallerContext): Promise<Hivekeeper>;
  createAgent(input: CreateAgentInput, caller: CallerContext): Promise<Agent>;
  revokeAgent(id: UUIDv7, caller: CallerContext): Promise<void>;
  listAgents(filter: ListAgentsFilter): Promise<ListAgentsResult>;
  listHivekeepers(filter: ListHivekeepersFilter): Promise<ListHivekeepersResult>;
}

export interface ParticipantsWriteRepoOptions {
  // Cap server-side. Per ADR-008 / spec env var HIVE_AUTH_LISTAGENTS_MAX_PAGE_SIZE.
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
      try {
        await db
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

      const row = await db
        .selectFrom('hivekeepers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return rowToHivekeeper(row);
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

    async listAgents(filter): Promise<ListAgentsResult> {
      const limit = Math.min(filter.pagination.limit, listMaxPageSize);

      let query = db.selectFrom('agents').selectAll().where('hive_id', '=', filter.hiveId);
      if (filter.ownerId !== undefined) {
        query = query.where('owner_id', '=', filter.ownerId);
      }
      if (filter.type !== undefined) {
        query = query.where('type', '=', filter.type);
      }
      if (filter.state !== undefined) {
        query = query.where('state', '=', filter.state);
      }
      if (filter.pagination.cursor) {
        const cursorIso = dateToIso(filter.pagination.cursor.createdAt);
        const cursorId = filter.pagination.cursor.id;
        // Keyset: rows strictly older than the cursor's (created_at, id).
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
      const agents = trimmed.map(rowToAgent);
      const last = agents.at(-1);
      const nextCursor: AuditCursor | null =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { agents, nextCursor };
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
