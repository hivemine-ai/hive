// Participants repository — read functions for Slice 0 (milestone 11).
// Write functions (createHivekeeper, createAgent, revokeAgent, listAgents,
// listHivekeepers) are added in block 3 (milestones 15-18).

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type { DbDialect } from '#persistence/db.js';
import { intToBool, isoToDate, jsonParse } from '#persistence/type-mappers.js';
import type {
  AgentsTable,
  Database,
  HivekeepersTable,
  HivesTable,
  ColoniesTable,
} from '#persistence/schema.js';
import type { UUIDv7 } from '../types.js';

import type {
  Agent,
  Colony,
  Hive,
  Hivekeeper,
  Participant,
  ParticipantStateSummary,
} from './entities.js';

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
}

export function createParticipantsReadRepo(
  db: Kysely<Database>,
  dialect: DbDialect = 'sqlite',
): ParticipantsReadRepo {
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
  };
}
