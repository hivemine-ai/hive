/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type doesn't reference the current Database interface. */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // ---------- cells ----------
  await db.schema
    .createTable('cells')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('owner_kind', 'text', (col) =>
      col.notNull().check(sql`owner_kind IN ('hivekeeper', 'agent')`),
    )
    .addColumn('state', 'text', (col) =>
      col
        .notNull()
        .defaultTo('active')
        .check(sql`state IN ('active', 'closed')`),
    )
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('closed_at', 'text')
    .execute();

  // Invariant: one Cell per participant.
  await sql`CREATE UNIQUE INDEX cells_owner_id_unique ON cells (owner_id)`.execute(db);

  // Partial index for active cells per Hive (metrics + scoped enumeration).
  await sql`CREATE INDEX idx_cells_hive_active ON cells (hive_id, state) WHERE state = 'active'`.execute(
    db,
  );

  // ---------- messages ----------
  await db.schema
    .createTable('messages')
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
    .addColumn('delivered_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('read_at', 'text')
    .addColumn('state', 'text', (col) =>
      col
        .notNull()
        .defaultTo('delivered')
        .check(sql`state IN ('sent', 'delivered', 'read', 'expired')`),
    )
    .addColumn('expired_at', 'text')
    .execute();

  // Hot path for readMailbox keyset pagination (recipient newest first + tiebreaker).
  await sql`CREATE INDEX idx_messages_cell_delivered ON messages (cell_id, delivered_at DESC, id DESC)`.execute(
    db,
  );

  // Partial index for the unread-only filter (check_unread_messages).
  await sql`CREATE INDEX idx_messages_cell_unread ON messages (cell_id, state, delivered_at DESC) WHERE state = 'delivered'`.execute(
    db,
  );

  // Supports correlation queries (responses to a known request_id).
  await sql`CREATE INDEX idx_messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL`.execute(
    db,
  );

  // Supports the expiration job filter on (sent_at + ttl_ms < now).
  await sql`CREATE INDEX idx_messages_sent_at ON messages (sent_at)`.execute(db);

  // Supports physical delete past grace period for expired messages.
  await sql`CREATE INDEX idx_messages_expired ON messages (state, expired_at) WHERE state = 'expired'`.execute(
    db,
  );

  // ---------- retention_policies ----------
  await db.schema
    .createTable('retention_policies')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('scope', 'text', (col) => col.notNull().check(sql`scope IN ('hive', 'hivekeeper')`))
    .addColumn('scope_id', 'text')
    .addColumn('unread_retention_ms', 'integer')
    .addColumn('read_retention_ms', 'integer')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('frozen_at', 'text')
    .addColumn('set_by', 'text')
    .execute();

  // Partial UNIQUE: a single default policy per Hive.
  await sql`CREATE UNIQUE INDEX retention_policies_hive_default_unique ON retention_policies (hive_id) WHERE scope = 'hive'`.execute(
    db,
  );

  // Partial UNIQUE: a single override per Hivekeeper.
  await sql`CREATE UNIQUE INDEX retention_policies_hivekeeper_override_unique ON retention_policies (hive_id, scope_id) WHERE scope = 'hivekeeper'`.execute(
    db,
  );

  // Lookup hot path for resolveEffectivePolicy.
  await sql`CREATE INDEX idx_retention_policies_scope ON retention_policies (scope, scope_id)`.execute(
    db,
  );

  // ---------- idempotency_keys ----------
  await db.schema
    .createTable('idempotency_keys')
    .addColumn('sender_id', 'text', (col) => col.notNull())
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint('idempotency_keys_pk', ['sender_id', 'key'])
    .execute();

  // Purge job filter (DELETE WHERE created_at < now - 24h).
  await sql`CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();
  await db.schema.dropTable('retention_policies').execute();
  await db.schema.dropTable('messages').execute();
  await db.schema.dropTable('cells').execute();
}
