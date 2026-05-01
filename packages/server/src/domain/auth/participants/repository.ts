// Participants repository — read functions for Slice 0 (milestone 11).
// Write functions (createHivekeeper, createAgent, revokeAgent, listHivekeepers,
// revokeHivekeeperWithCascade) live in repository.write.ts. listAgents lives here
// even though it was added together with the write functions in PRY-002 — it does
// not require an admin caller and is consumed by the MCP `list_agents` tool which
// is a pure read operation. Relocated here in PRY-029.

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type { DbDialect } from '#persistence/db.js';
import { intToBool, isoToDate, jsonParse } from '#persistence/type-mappers.js';
import type { Logger } from '#observability/logger.js';
import type {
  AgentsTable,
  Database,
  HivekeepersTable,
  HivesTable,
  ColoniesTable,
} from '#persistence/schema.js';
import type { ParticipantState, UUIDv7 } from '../types.js';

import type {
  Agent,
  Colony,
  Hive,
  Hivekeeper,
  Participant,
  ParticipantStateSummary,
} from './entities.js';

// ---------- Pagination + listing types (used by listAgents and listHivekeepers) ----------

/**
 * Composite keyset cursor for paginated listings ordered by `(created_at DESC, id DESC)`.
 * Stable under concurrent inserts (UUID v7 is monotonic and `created_at` is set at INSERT
 * time). Wire-side serialization is the caller's responsibility — the repo treats this
 * as an opaque value.
 */
export interface AuditCursor {
  createdAt: Date;
  id: UUIDv7;
}

export interface ListAgentsFilter {
  hiveId: UUIDv7;
  ownerId?: UUIDv7;
  type?: 'worker' | 'scout';
  state?: ParticipantState;
  /**
   * Substring match against the JSON-stringified `capabilities` text column. Cross-
   * dialect via `LIKE '%' || ? || '%'`. False positives are possible if the query
   * string contains JSON-meta characters (`"`, `\`, `[`, `]`, `,`) — accepted as
   * v0.1 simplicity cost; flag for v0.2 push-down (`array_contains` or similar).
   */
  capability?: string;
  pagination: { cursor: AuditCursor | null; limit: number };
}

export interface ListAgentsResult {
  agents: Agent[];
  nextCursor: AuditCursor | null;
}

// ---------- Row → entity mappers ----------

function rowToHive(row: Selectable<HivesTable>): Hive {
  return {
    id: row.id,
    name: row.name,
    createdAt: isoToDate(row.created_at),
  };
}

function rowToColony(row: Selectable<ColoniesTable>): Colony {
  return {
    id: row.id,
    hiveId: row.hive_id,
    name: row.name,
    createdAt: isoToDate(row.created_at),
  };
}

function rowToHivekeeper(row: Selectable<HivekeepersTable>): Hivekeeper {
  return {
    id: row.id,
    hiveId: row.hive_id,
    colonyId: row.colony_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: intToBool(row.is_admin),
    state: row.state,
    createdAt: isoToDate(row.created_at),
    revokedAt: row.revoked_at ? isoToDate(row.revoked_at) : null,
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
    createdAt: isoToDate(row.created_at),
    revokedAt: row.revoked_at ? isoToDate(row.revoked_at) : null,
    lastConnectedAt: row.last_connected_at ? isoToDate(row.last_connected_at) : null,
  };
}

// ---------- Repository factory ----------

/**
 * Type alias for the Kysely query executor — either the outer DB handle or an
 * open Transaction. Mirrors the shape used by `cellsRepo` for symmetric APIs.
 */
export type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface ParticipantsReadRepo {
  findHiveById(id: UUIDv7): Promise<Hive | null>;
  findColonyById(id: UUIDv7): Promise<Colony | null>;
  findHivekeeperById(id: UUIDv7): Promise<Hivekeeper | null>;
  findHivekeeperByEmail(hiveId: UUIDv7, email: string): Promise<Hivekeeper | null>;
  /**
   * Looks up a Hivekeeper whose email local-part (the segment before `@`)
   * matches `localPart` case-insensitively within the given Hive. Used by the
   * MCP transport to resolve agent references of the form
   * `<agent>@<owner-email-local>.<hive-name>` (per ADR-015).
   *
   * Cross-dialect substring extraction:
   *   - SQLite uses `INSTR(email, '@')` (Postgres has no `INSTR`).
   *   - Postgres uses `STRPOS(email, '@')` (SQLite has no `STRPOS`).
   * The dialect is selected at factory time. `lower(...)` is SQL-standard and
   * works in both, mirroring the case-folding pattern of `findHivekeeperByEmail`.
   */
  findHivekeeperByEmailLocalPart(hiveId: UUIDv7, localPart: string): Promise<Hivekeeper | null>;
  findAgentById(id: UUIDv7): Promise<Agent | null>;
  findAgentByName(hiveId: UUIDv7, ownerId: UUIDv7, name: string): Promise<Agent | null>;
  /**
   * Polymorphic lookup used by the verifier (step 5). Issues two queries in
   * parallel. Accepts an optional `executor` so callers inside an open Kysely
   * transaction can reuse the TX connection — required for SQLite single-
   * connection determinism (PRY-006 discovery: visibility.canSend invoked
   * mid-TX from cellStore.sendMessage deadlocked on the outer `db` handle).
   */
  findById(id: UUIDv7, executor?: DbExecutor): Promise<Participant | null>;
  /** Minimal projection for hot paths (verifier step 6/7, pre-conditions). */
  getParticipantState(id: UUIDv7): Promise<ParticipantStateSummary | null>;
  /**
   * Lists agents in a hive with optional filters and keyset pagination ordered by
   * `(created_at DESC, id DESC)`. Consumed by the MCP `list_agents` tool — the
   * handler is responsible for projecting `Agent[]` to the wire `AgentSummary`
   * shape and for serializing `AuditCursor` to an opaque string.
   */
  listAgents(filter: ListAgentsFilter): Promise<ListAgentsResult>;
  /**
   * Stamps `agents.last_connected_at` with `timestamp` for the given agent. Invoked
   * as a non-blocking side effect of `presenceRegistry.subscribe` for `worker` and
   * `scout` participants — never for `hivekeeper`. Silent no-op (logger.warn) when
   * `agentId` does not resolve to a row, so a deleted-agent race never aborts the
   * subscribe path. Idempotent: repeat calls overwrite the value with the latest.
   */
  updateAgentLastConnectedAt(agentId: UUIDv7, timestamp: Date): Promise<void>;
}

export interface ParticipantsReadRepoOptions {
  /**
   * Server-side cap on `pagination.limit` for `listAgents`. The handler in the MCP
   * transport applies its own zod-level cap from `HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE`
   * — this option exists for repo-level tests that want to exercise pagination with
   * a smaller cap without depending on env vars. Defaults to 200 (loose enough that
   * the wire cap of 100 is the binding constraint in production).
   */
  listMaxPageSize?: number;
  /**
   * Logger consumed by `updateAgentLastConnectedAt` to warn when the targeted
   * `agentId` does not resolve (deleted between subscribe and the async UPDATE).
   * Optional — falls back to a noop logger so existing test callsites don't break.
   */
  logger?: Logger;
}

export function createParticipantsReadRepo(
  db: Kysely<Database>,
  dialect: DbDialect = 'sqlite',
  opts: ParticipantsReadRepoOptions = {},
): ParticipantsReadRepo {
  const listMaxPageSize = opts.listMaxPageSize ?? 200;
  const logger = opts.logger;
  // Dialect-aware substring index (1-based) of the first `@` in `email`.
  // INSTR is SQLite-only; STRPOS is Postgres-only — kept as `sql` fragments so
  // Kysely passes them through verbatim and the planner picks the right path.
  const atPosition = dialect === 'sqlite' ? sql`INSTR(email, '@')` : sql`STRPOS(email, '@')`;

  return {
    async findHiveById(id) {
      const row = await db.selectFrom('hives').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? rowToHive(row) : null;
    },

    async findColonyById(id) {
      const row = await db
        .selectFrom('colonies')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? rowToColony(row) : null;
    },

    async findHivekeeperById(id) {
      const row = await db
        .selectFrom('hivekeepers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? rowToHivekeeper(row) : null;
    },

    async findHivekeeperByEmail(hiveId, email) {
      const row = await db
        .selectFrom('hivekeepers')
        .selectAll()
        .where('hive_id', '=', hiveId)
        .where(sql`lower(email)`, '=', email.toLowerCase())
        .executeTakeFirst();
      return row ? rowToHivekeeper(row) : null;
    },

    async findHivekeeperByEmailLocalPart(hiveId, localPart) {
      const row = await db
        .selectFrom('hivekeepers')
        .selectAll()
        .where('hive_id', '=', hiveId)
        .where(sql`lower(SUBSTR(email, 1, ${atPosition} - 1))`, '=', localPart.toLowerCase())
        .executeTakeFirst();
      return row ? rowToHivekeeper(row) : null;
    },

    async findAgentById(id) {
      const row = await db.selectFrom('agents').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? rowToAgent(row) : null;
    },

    async findAgentByName(hiveId, ownerId, name) {
      const row = await db
        .selectFrom('agents')
        .selectAll()
        .where('hive_id', '=', hiveId)
        .where('owner_id', '=', ownerId)
        .where('name', '=', name)
        .where('state', '!=', 'revoked')
        .executeTakeFirst();
      return row ? rowToAgent(row) : null;
    },

    async findById(id, executor) {
      const exec = executor ?? db;
      const [hkRow, agRow] = await Promise.all([
        exec.selectFrom('hivekeepers').selectAll().where('id', '=', id).executeTakeFirst(),
        exec.selectFrom('agents').selectAll().where('id', '=', id).executeTakeFirst(),
      ]);
      if (hkRow) {
        return {
          kind: 'hivekeeper',
          hivekeeper: rowToHivekeeper(hkRow),
        };
      }
      if (agRow) {
        return { kind: 'agent', agent: rowToAgent(agRow) };
      }
      return null;
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
      if (filter.capability !== undefined) {
        // Substring match against the JSON-stringified capabilities array. `LIKE`
        // is portable across SQLite and Postgres. False positives possible for
        // strings that contain JSON meta-chars — documented in the field's JSDoc.
        query = query.where('capabilities', 'like', `%${filter.capability}%`);
      }
      if (filter.pagination.cursor) {
        const cursorIso = filter.pagination.cursor.createdAt.toISOString();
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

    async getParticipantState(id) {
      const [hkRow, agRow] = await Promise.all([
        db
          .selectFrom('hivekeepers')
          .select(['hive_id', 'colony_id', 'is_admin', 'state'])
          .where('id', '=', id)
          .executeTakeFirst(),
        db
          .selectFrom('agents')
          .select(['hive_id', 'colony_id', 'owner_id', 'type', 'state'])
          .where('id', '=', id)
          .executeTakeFirst(),
      ]);
      if (hkRow) {
        return {
          kind: 'hivekeeper',
          state: hkRow.state,
          isAdmin: intToBool(hkRow.is_admin),
          hiveId: hkRow.hive_id,
          colonyId: hkRow.colony_id,
          ownerId: null,
        };
      }
      if (agRow) {
        return {
          kind: agRow.type,
          state: agRow.state,
          isAdmin: null,
          hiveId: agRow.hive_id,
          colonyId: agRow.colony_id,
          ownerId: agRow.owner_id,
        };
      }
      return null;
    },

    async updateAgentLastConnectedAt(agentId, timestamp) {
      const result = await db
        .updateTable('agents')
        .set({ last_connected_at: timestamp.toISOString() })
        .where('id', '=', agentId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        logger?.warn(
          { agentId },
          'updateAgentLastConnectedAt_no_row — agent vanished between subscribe and async UPDATE',
        );
      }
    },
  };
}
