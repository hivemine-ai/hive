// Participants repository — read functions for Slice 0 (Hito 11).
// Write functions (createHivekeeper, createAgent, revokeAgent, listAgents,
// listHivekeepers) are added in Bloque 3 (Hitos 15-18).

import { sql, type Kysely, type Selectable } from 'kysely';

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

export interface ParticipantsReadRepo {
  findHiveById(id: UUIDv7): Promise<Hive | null>;
  findColonyById(id: UUIDv7): Promise<Colony | null>;
  findHivekeeperById(id: UUIDv7): Promise<Hivekeeper | null>;
  findHivekeeperByEmail(hiveId: UUIDv7, email: string): Promise<Hivekeeper | null>;
  findAgentById(id: UUIDv7): Promise<Agent | null>;
  findAgentByName(hiveId: UUIDv7, ownerId: UUIDv7, name: string): Promise<Agent | null>;
  /** Polymorphic lookup used by the verifier (step 5). Issues two queries in parallel. */
  findById(id: UUIDv7): Promise<Participant | null>;
  /** Minimal projection for hot paths (verifier step 6/7, pre-conditions). */
  getParticipantState(id: UUIDv7): Promise<ParticipantStateSummary | null>;
}

export function createParticipantsReadRepo(db: Kysely<Database>): ParticipantsReadRepo {
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

    async findById(id) {
      const [hkRow, agRow] = await Promise.all([
        db.selectFrom('hivekeepers').selectAll().where('id', '=', id).executeTakeFirst(),
        db.selectFrom('agents').selectAll().where('id', '=', id).executeTakeFirst(),
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
