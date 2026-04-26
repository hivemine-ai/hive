// Cell Store repository — read/write functions for Bloque 0 (PRY-003).
// The send/read/policy/idempotency/expiration modules consume this layer in later bloques.
//
// Per the tech spec ("tx opcional" pattern): every method accepts an optional `executor`
// (Kysely<Database> | Transaction<Database>) so callers can participate in an outer
// transaction (e.g. createAgent + createCell). When omitted, the bound `db` is used.

import type { Kysely, Selectable, Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { dateToIso, isoToDate, jsonParse } from '#persistence/type-mappers.js';
import type { CellsTable, Database, MessagesTable } from '#persistence/schema.js';

import type {
  ActionDescriptor,
  Cell,
  CellState,
  Message,
  MessageType,
  MessageView,
} from './types.js';
import type { UUIDv7 } from '#domain/auth/types.js';

export type DbExecutor = Kysely<Database> | Transaction<Database>;

// ---------- Row → entity mappers ----------

function rowToCell(row: Selectable<CellsTable>): Cell {
  return {
    id: row.id,
    hiveId: row.hive_id,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    state: row.state,
    createdAt: isoToDate(row.created_at),
    closedAt: row.closed_at ? isoToDate(row.closed_at) : null,
  };
}

// `rowToMessage` materializes the full `Message` entity (DB-side, including `expiredAt`).
// Consumed by `findMessageById` (PRY-005 MCP — `send_message` reply_to validation).
// `action` is stored as JSON text and may be NULL; `null` is preserved verbatim.
function rowToMessage(row: Selectable<MessagesTable>): Message {
  return {
    id: row.id,
    cellId: row.cell_id,
    fromParticipantId: row.from_participant_id,
    toParticipantId: row.to_participant_id,
    type: row.type,
    body: row.body,
    action: row.action ? jsonParse<ActionDescriptor>(row.action) : null,
    replyTo: row.reply_to,
    ttl: row.ttl_ms,
    sentAt: isoToDate(row.sent_at),
    deliveredAt: isoToDate(row.delivered_at),
    readAt: row.read_at ? isoToDate(row.read_at) : null,
    state: row.state,
    expiredAt: row.expired_at ? isoToDate(row.expired_at) : null,
  };
}

function rowToMessageView(row: Selectable<MessagesTable>): MessageView {
  return {
    id: row.id,
    from: row.from_participant_id,
    to: row.to_participant_id,
    type: row.type,
    body: row.body,
    action: row.action ? jsonParse<ActionDescriptor>(row.action) : null,
    replyTo: row.reply_to,
    ttl: row.ttl_ms,
    sentAt: isoToDate(row.sent_at),
    deliveredAt: isoToDate(row.delivered_at),
    readAt: row.read_at ? isoToDate(row.read_at) : null,
    state: row.state,
  };
}

/**
 * Map the polymorphic IdentityContext.kind ('hivekeeper' | 'worker' | 'scout') to the
 * cells.owner_kind discriminator ('hivekeeper' | 'agent'). Workers and Scouts collapse
 * to 'agent' — Cell Store doesn't need to distinguish them.
 */
export function mapKindToOwnerKind(
  kind: 'hivekeeper' | 'worker' | 'scout',
): 'hivekeeper' | 'agent' {
  return kind === 'hivekeeper' ? 'hivekeeper' : 'agent';
}

// ---------- Public surface ----------

export interface CreateCellInput {
  ownerId: UUIDv7;
  ownerKind: 'hivekeeper' | 'agent';
  hiveId: UUIDv7;
}

export interface CloseCellInput {
  cellId?: UUIDv7;
  ownerId?: UUIDv7;
}

export interface CloseCellResult {
  closedCellIds: UUIDv7[];
}

export interface GetCellStateResult {
  state: CellState;
  ownerId: UUIDv7;
  ownerKind: 'hivekeeper' | 'agent';
}

export interface ListMessagesFilter {
  unreadOnly?: boolean;
  types?: MessageType[];
}

export interface ListMessagesPagination {
  cursor: { deliveredAt: Date; messageId: UUIDv7 } | null;
  limit: number;
}

export interface MarkMessageReadResult {
  affected: number;
}

export interface SummarizeUnreadResult {
  unreadCount: number;
  distinctSenderIds: UUIDv7[];
}

export interface CellsRepo {
  /** PK lookup by owner — UNIQUE index. */
  findCellByOwner(ownerId: UUIDv7, executor?: DbExecutor): Promise<Cell | null>;

  /** PK lookup by Cell id. */
  findCellById(cellId: UUIDv7, executor?: DbExecutor): Promise<Cell | null>;

  /** Minimal projection for verifier hot path. */
  getCellState(cellId: UUIDv7, executor?: DbExecutor): Promise<GetCellStateResult | null>;

  /**
   * INSERT a Cell with state='active'. UNIQUE on owner_id is enforced; on conflict
   * the underlying SQL error is rethrown (the auth caller will not need a typed error here).
   */
  createCell(input: CreateCellInput, executor?: DbExecutor): Promise<Cell>;

  /**
   * UPDATE state='closed', closed_at=now() for cells matched by id and/or owner_id.
   * Idempotent: re-call on already-closed cells is a no-op (returns []).
   * At least one of `cellId` / `ownerId` MUST be provided; both is allowed.
   */
  closeCell(input: CloseCellInput, executor?: DbExecutor): Promise<CloseCellResult>;

  /** Batch close: UPDATE state='closed' WHERE owner_id IN (...) AND state='active'. */
  closeCellsByOwner(ownerIds: UUIDv7[], executor?: DbExecutor): Promise<CloseCellResult>;

  /** INSERT a Message row. CHECKs (type, state) enforced by the DB. */
  insertMessage(message: Message, executor?: DbExecutor): Promise<void>;

  /**
   * Mark a single message as read. Returns the number of rows affected:
   *   1 — transitioned from {sent, delivered} → read
   *   0 — already read, expired, or unknown id (idempotent for caller)
   */
  markMessageRead(
    messageId: UUIDv7,
    cellId: UUIDv7,
    readAt: Date,
    executor?: DbExecutor,
  ): Promise<MarkMessageReadResult>;

  /** Keyset pagination over messages of a Cell. Always filters out `state='expired'`. */
  listMessages(
    cellId: UUIDv7,
    filter: ListMessagesFilter,
    pagination: ListMessagesPagination,
    executor?: DbExecutor,
  ): Promise<MessageView[]>;

  /**
   * Aggregated unread summary for a Cell — consumed by Waggle (PRY-004) push pipeline.
   *
   * Single aggregated query filtered by materialized `state = 'delivered'`. Returns:
   *   - `unreadCount`: total count across delivered messages.
   *   - `distinctSenderIds`: distinct `from_participant_id`s, ordered by
   *     `MAX(delivered_at) DESC` with `from_participant_id ASC` tiebreaker
   *     (per tech spec — deterministic across SQLite/Postgres).
   *
   * Defense-in-depth: if there are no rows (e.g. closed Cell with no delivered messages),
   * returns `{ unreadCount: 0, distinctSenderIds: [] }` silently — no error. The query
   * is NOT cell-state-gated; per the tech spec, no normal caller invokes this on a
   * closed Cell (Waggle suppresses push beforehand), so the contract simply reports
   * what the index sees. Does not invoke `computeMessageState`; transiently-expired
   * rows pending the materialization job may count (≤ HIVE_CELL_EXPIRATION_INTERVAL_SECONDS drift).
   */
  summarizeUnreadForCell(cellId: UUIDv7, executor?: DbExecutor): Promise<SummarizeUnreadResult>;

  /**
   * PK lookup with cell-membership guard — consumed by PRY-005 MCP (`send_message`
   * `reply_to` validation). Returns the `Message` entity if the row exists in the
   * given Cell and is not in `state='expired'`. Otherwise returns `null`.
   *
   * Privacy: a message that exists in another Cell returns `null`, indistinguishable
   * from "not found". Defense in depth: filters out `state='expired'` even though
   * the expiration job is deferred in B0.
   */
  findMessageById(
    messageId: UUIDv7,
    cellId: UUIDv7,
    executor?: DbExecutor,
  ): Promise<Message | null>;
}

// ---------- Factory ----------

export function createCellsRepo(db: Kysely<Database>): CellsRepo {
  return {
    async findCellByOwner(ownerId, executor) {
      const exec = executor ?? db;
      const row = await exec
        .selectFrom('cells')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      return row ? rowToCell(row) : null;
    },

    async findCellById(cellId, executor) {
      const exec = executor ?? db;
      const row = await exec
        .selectFrom('cells')
        .selectAll()
        .where('id', '=', cellId)
        .executeTakeFirst();
      return row ? rowToCell(row) : null;
    },

    async getCellState(cellId, executor) {
      const exec = executor ?? db;
      const row = await exec
        .selectFrom('cells')
        .select(['state', 'owner_id', 'owner_kind'])
        .where('id', '=', cellId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        state: row.state,
        ownerId: row.owner_id,
        ownerKind: row.owner_kind,
      };
    },

    async createCell(input, executor) {
      const exec = executor ?? db;
      const id = uuidv7();
      const now = new Date();
      await exec
        .insertInto('cells')
        .values({
          id,
          hive_id: input.hiveId,
          owner_id: input.ownerId,
          owner_kind: input.ownerKind,
          state: 'active',
          created_at: dateToIso(now),
          closed_at: null,
        })
        .execute();

      const row = await exec
        .selectFrom('cells')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return rowToCell(row);
    },

    async closeCell(input, executor) {
      if (input.cellId === undefined && input.ownerId === undefined) {
        throw new Error('closeCell requires at least one of { cellId, ownerId }');
      }
      const exec = executor ?? db;

      // Identify candidates that are still active so we know exactly which transitioned.
      let selectQuery = exec.selectFrom('cells').select('id').where('state', '=', 'active');
      if (input.cellId !== undefined) {
        selectQuery = selectQuery.where('id', '=', input.cellId);
      }
      if (input.ownerId !== undefined) {
        selectQuery = selectQuery.where('owner_id', '=', input.ownerId);
      }
      const candidates = await selectQuery.execute();
      if (candidates.length === 0) {
        return { closedCellIds: [] };
      }

      const ids = candidates.map((c) => c.id);
      await exec
        .updateTable('cells')
        .set({ state: 'closed', closed_at: dateToIso(new Date()) })
        .where('id', 'in', ids)
        .execute();

      return { closedCellIds: ids };
    },

    async closeCellsByOwner(ownerIds, executor) {
      if (ownerIds.length === 0) {
        return { closedCellIds: [] };
      }
      const exec = executor ?? db;

      const candidates = await exec
        .selectFrom('cells')
        .select('id')
        .where('owner_id', 'in', ownerIds)
        .where('state', '=', 'active')
        .execute();
      if (candidates.length === 0) {
        return { closedCellIds: [] };
      }

      const ids = candidates.map((c) => c.id);
      await exec
        .updateTable('cells')
        .set({ state: 'closed', closed_at: dateToIso(new Date()) })
        .where('id', 'in', ids)
        .execute();

      return { closedCellIds: ids };
    },

    async insertMessage(message, executor) {
      const exec = executor ?? db;
      await exec
        .insertInto('messages')
        .values({
          id: message.id,
          cell_id: message.cellId,
          from_participant_id: message.fromParticipantId,
          to_participant_id: message.toParticipantId,
          type: message.type,
          body: message.body,
          action: message.action ? JSON.stringify(message.action) : null,
          reply_to: message.replyTo,
          ttl_ms: message.ttl,
          sent_at: dateToIso(message.sentAt),
          delivered_at: dateToIso(message.deliveredAt),
          read_at: message.readAt ? dateToIso(message.readAt) : null,
          state: message.state,
          expired_at: message.expiredAt ? dateToIso(message.expiredAt) : null,
        })
        .execute();
    },

    async markMessageRead(messageId, cellId, readAt, executor) {
      const exec = executor ?? db;
      const result = await exec
        .updateTable('messages')
        .set({ read_at: dateToIso(readAt), state: 'read' })
        .where('id', '=', messageId)
        .where('cell_id', '=', cellId)
        .where('read_at', 'is', null)
        .where('state', 'in', ['sent', 'delivered'])
        .executeTakeFirst();
      return { affected: Number(result.numUpdatedRows ?? 0n) };
    },

    async listMessages(cellId, filter, pagination, executor) {
      const exec = executor ?? db;
      let query = exec
        .selectFrom('messages')
        .selectAll()
        .where('cell_id', '=', cellId)
        // Defense in depth: never expose expired messages even if a caller forgot to filter.
        .where('state', '!=', 'expired');

      if (filter.unreadOnly === true) {
        query = query.where('state', '=', 'delivered');
      }
      if (filter.types && filter.types.length > 0) {
        query = query.where('type', 'in', filter.types);
      }
      if (pagination.cursor) {
        const cursorIso = dateToIso(pagination.cursor.deliveredAt);
        const cursorId = pagination.cursor.messageId;
        // Keyset: rows strictly older than the cursor's (delivered_at, id).
        query = query.where((eb) =>
          eb.or([
            eb('delivered_at', '<', cursorIso),
            eb.and([eb('delivered_at', '=', cursorIso), eb('id', '<', cursorId)]),
          ]),
        );
      }
      query = query.orderBy('delivered_at', 'desc').orderBy('id', 'desc').limit(pagination.limit);

      const rows = await query.execute();
      return rows.map(rowToMessageView);
    },

    async summarizeUnreadForCell(cellId, executor) {
      const exec = executor ?? db;
      // Single aggregated query: GROUP BY sender, count + MAX(delivered_at) for ordering.
      // The JS-side reduce/map is trivial and respects the spec ordering
      // (MAX(delivered_at) DESC, from_participant_id ASC).
      const rows = await exec
        .selectFrom('messages')
        .select((eb) => [
          'from_participant_id',
          eb.fn.countAll<number>().as('cnt'),
          eb.fn.max('delivered_at').as('max_delivered'),
        ])
        .where('cell_id', '=', cellId)
        .where('state', '=', 'delivered')
        .groupBy('from_participant_id')
        .orderBy('max_delivered', 'desc')
        .orderBy('from_participant_id', 'asc')
        .execute();

      // SQLite COUNT(*) may return number or string depending on driver — coerce.
      const unreadCount = rows.reduce((acc, r) => acc + Number(r.cnt), 0);
      const distinctSenderIds = rows.map((r) => r.from_participant_id);
      return { unreadCount, distinctSenderIds };
    },

    async findMessageById(messageId, cellId, executor) {
      const exec = executor ?? db;
      const row = await exec
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', messageId)
        .where('cell_id', '=', cellId)
        // Defense in depth: expired messages are treated as inexistent.
        .where('state', '!=', 'expired')
        .executeTakeFirst();
      return row ? rowToMessage(row) : null;
    },
  };
}
