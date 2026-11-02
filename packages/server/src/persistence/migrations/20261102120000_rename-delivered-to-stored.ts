/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type does not reference the current Database interface. */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// PRY-075 — renames the `messages` storage vocabulary for v0.2.0, without aliases:
//   - column `delivered_at` becomes `stored_at`
//   - persisted state value `delivered` becomes `stored`
//   - the state CHECK and the partial indexes follow
//
// SQLite cannot drop an inline CHECK, so both dialects rebuild the table the same way.
// `messages` is not referenced by any foreign key, so the swap is safe. Both directions
// are idempotent: they return early when the target column already exists.

type Vocabulary = { timestamp: string; state: string };

const OLD: Vocabulary = { timestamp: 'delivered_at', state: 'delivered' };
const NEW: Vocabulary = { timestamp: 'stored_at', state: 'stored' };

async function rebuildMessages(db: Kysely<any>, from: Vocabulary, to: Vocabulary): Promise<void> {
  const tables = await db.introspection.getTables();
  const messages = tables.find((t) => t.name === 'messages');
  if (messages?.columns.some((c) => c.name === to.timestamp)) return;

  await sql`DROP TABLE IF EXISTS messages_rebuild`.execute(db);

  await db.schema
    .createTable('messages_rebuild')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('cell_id', 'text', (col) => col.notNull().references('cells.id'))
    .addColumn('from_participant_id', 'text', (col) => col.notNull())
    .addColumn('to_participant_id', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) =>
      col.notNull().check(sql`type IN ('request', 'response', 'notification')`),
    )
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('action', 'text')
    .addColumn('reply_to', 'text')
    .addColumn('ttl_ms', 'integer')
    .addColumn('sent_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn(to.timestamp, 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('read_at', 'text')
    .addColumn('state', 'text', (col) =>
      col
        .notNull()
        .defaultTo(to.state)
        .check(sql`state IN ('sent', ${sql.lit(to.state)}, 'read', 'expired')`),
    )
    .addColumn('expired_at', 'text')
    .execute();

  await sql`
    INSERT INTO messages_rebuild (
      id, cell_id, from_participant_id, to_participant_id, type, body, action, reply_to,
      ttl_ms, sent_at, ${sql.ref(to.timestamp)}, read_at, state, expired_at
    )
    SELECT
      id, cell_id, from_participant_id, to_participant_id, type, body, action, reply_to,
      ttl_ms, sent_at, ${sql.ref(from.timestamp)}, read_at,
      CASE WHEN state = ${sql.lit(from.state)} THEN ${sql.lit(to.state)} ELSE state END,
      expired_at
    FROM messages
  `.execute(db);

  await sql`DROP TABLE messages`.execute(db);
  await sql`ALTER TABLE messages_rebuild RENAME TO messages`.execute(db);

  const timestamp = sql.ref(to.timestamp);
  await sql`CREATE INDEX ${sql.ref(`idx_messages_cell_${to.state}`)} ON messages (cell_id, ${timestamp} DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_messages_cell_unread ON messages (cell_id, state, ${timestamp} DESC) WHERE state = ${sql.lit(to.state)}`.execute(
    db,
  );
  await sql`CREATE INDEX idx_messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX idx_messages_sent_at ON messages (sent_at)`.execute(db);
  await sql`CREATE INDEX idx_messages_expired ON messages (state, expired_at) WHERE state = 'expired'`.execute(
    db,
  );
}

export async function up(db: Kysely<any>): Promise<void> {
  await rebuildMessages(db, OLD, NEW);
}

export async function down(db: Kysely<any>): Promise<void> {
  await rebuildMessages(db, NEW, OLD);
}
