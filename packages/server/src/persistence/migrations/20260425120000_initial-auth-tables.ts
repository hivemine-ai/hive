/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type doesn't reference the current Database interface. */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // ---------- hives ----------
  await db.schema
    .createTable('hives')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // ---------- colonies ----------
  await db.schema
    .createTable('colonies')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex('idx_colonies_hive_id').on('colonies').column('hive_id').execute();

  // ---------- hivekeepers ----------
  await db.schema
    .createTable('hivekeepers')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('colony_id', 'text', (col) => col.notNull().references('colonies.id'))
    .addColumn('email', 'text', (col) => col.notNull())
    .addColumn('display_name', 'text')
    .addColumn('is_admin', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('state', 'text', (col) =>
      col
        .notNull()
        .defaultTo('active')
        .check(sql`state IN ('active', 'revoked')`),
    )
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('revoked_at', 'text')
    .execute();

  // Functional UNIQUE index for case-insensitive email uniqueness per hive.
  await sql`CREATE UNIQUE INDEX hivekeepers_hive_email_unique ON hivekeepers (hive_id, lower(email))`.execute(
    db,
  );

  // Partial index for active hivekeepers (hot path for list / lookups).
  await sql`CREATE INDEX idx_hivekeepers_hive_active ON hivekeepers (hive_id, state) WHERE state = 'active'`.execute(
    db,
  );

  // Partial index for active admin hivekeepers — supports LAST_ADMIN_INVARIANT check.
  await sql`CREATE INDEX idx_hivekeepers_active_admins ON hivekeepers (hive_id) WHERE is_admin = 1 AND state = 'active'`.execute(
    db,
  );

  // ---------- agents ----------
  await db.schema
    .createTable('agents')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('colony_id', 'text', (col) => col.notNull().references('colonies.id'))
    .addColumn('owner_id', 'text', (col) => col.notNull().references('hivekeepers.id'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull().check(sql`type IN ('worker', 'scout')`))
    .addColumn('capabilities', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('instructions', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('state', 'text', (col) =>
      col
        .notNull()
        .defaultTo('active')
        .check(sql`state IN ('active', 'suspended', 'revoked')`),
    )
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('revoked_at', 'text')
    .execute();

  // Unique agent name per owner, scoped to non-revoked rows (allows reuse after revoke).
  await sql`CREATE UNIQUE INDEX agents_owner_name_active_uq ON agents (owner_id, name) WHERE state != 'revoked'`.execute(
    db,
  );

  // Hot path: enumerate active agents by owner.
  await sql`CREATE INDEX idx_agents_owner_active ON agents (owner_id, state) WHERE state = 'active'`.execute(
    db,
  );

  // Public Scout directory (per API MCP — Tools).
  await sql`CREATE INDEX idx_agents_active_scouts ON agents (hive_id, type, state) WHERE type = 'scout' AND state = 'active'`.execute(
    db,
  );

  // ---------- credentials ----------
  await db.schema
    .createTable('credentials')
    .addColumn('jti', 'text', (col) => col.primaryKey())
    .addColumn('participant_id', 'text', (col) => col.notNull())
    .addColumn('participant_kind', 'text', (col) =>
      col.notNull().check(sql`participant_kind IN ('hivekeeper', 'worker', 'scout')`),
    )
    .addColumn('kid', 'text', (col) => col.notNull())
    .addColumn('issued_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('not_before', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('snapshot', 'text', (col) => col.notNull())
    .addColumn('issued_by', 'text')
    .addColumn('revoked_at', 'text')
    .execute();

  // Listing credentials of a participant by recency.
  await sql`CREATE INDEX idx_credentials_participant_expires ON credentials (participant_id, expires_at DESC)`.execute(
    db,
  );

  // Purge job filter on expiry.
  await sql`CREATE INDEX idx_credentials_expires_at ON credentials (expires_at)`.execute(db);

  // ---------- credential_revocations (blocklist persistente) ----------
  await db.schema
    .createTable('credential_revocations')
    .addColumn('jti', 'text', (col) => col.primaryKey())
    .addColumn('revoked_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('revoked_by', 'text')
    .addColumn('reason', 'text')
    .addColumn('credential_expires_at', 'text', (col) => col.notNull())
    .execute();

  await sql`CREATE INDEX idx_credential_revocations_expires ON credential_revocations (credential_expires_at)`.execute(
    db,
  );

  // ---------- signing_keys ----------
  await db.schema
    .createTable('signing_keys')
    .addColumn('kid', 'text', (col) => col.primaryKey())
    .addColumn('algorithm', 'text', (col) =>
      col
        .notNull()
        .defaultTo('EdDSA')
        .check(sql`algorithm = 'EdDSA'`),
    )
    .addColumn('public_jwk', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('retired_at', 'text')
    .addColumn('removed_at', 'text')
    .execute();

  // ---------- distributed_locks (portable advisory lock primitive) ----------
  await db.schema
    .createTable('distributed_locks')
    .addColumn('lock_id', 'text', (col) => col.primaryKey())
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('acquired_at', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .execute();

  await sql`CREATE INDEX idx_distributed_locks_expires ON distributed_locks (expires_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('distributed_locks').execute();
  await db.schema.dropTable('signing_keys').execute();
  await db.schema.dropTable('credential_revocations').execute();
  await db.schema.dropTable('credentials').execute();
  await db.schema.dropTable('agents').execute();
  await db.schema.dropTable('hivekeepers').execute();
  await db.schema.dropTable('colonies').execute();
  await db.schema.dropTable('hives').execute();
}
