/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type doesn't reference the current Database interface. */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// PRY-027 / ADR-018 — expand idempotency_keys PK from (sender_id, key) to
// (sender_id, recipient_id, key). Closes INC-2026-001 #4 (silent message loss
// when a client reused the same key across recipients).
//
// Strategy: drop + recreate. Rows are TTL 24h; loss of in-flight rows is
// acceptable per ADR-018 § Consequences. The down migration is symmetric.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();

  await db.schema
    .createTable('idempotency_keys')
    .addColumn('sender_id', 'text', (col) => col.notNull())
    .addColumn('recipient_id', 'text', (col) => col.notNull())
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint('idempotency_keys_pk', ['sender_id', 'recipient_id', 'key'])
    .execute();

  await sql`CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();

  await db.schema
    .createTable('idempotency_keys')
    .addColumn('sender_id', 'text', (col) => col.notNull())
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint('idempotency_keys_pk', ['sender_id', 'key'])
    .execute();

  await sql`CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at)`.execute(db);
}
