/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type does not reference the current Database interface. */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

// PRY-090 (ADR-026) — session enrollment schema:
//   - `agents`: `origin`, `enrolled_via`, `description`, `retired_at`, `last_worker_jti`,
//     the `retired` state and the three enrollment CHECKs and partial indexes.
//   - `credentials`: `scope` and `enrolled_via`, plus the partial index of the revocation
//     cascade.
//
// SQLite cannot widen an inline CHECK, so `agents` is rebuilt (create, copy, swap) in both
// dialects, the same way as the `messages` rebuild of 20261102120000. No foreign key
// references `agents`, so the swap is safe. Existing agents get `origin = 'manual'` from
// the column default. Kysely runs Postgres migrations in a transaction but not SQLite ones,
// so the rebuild opens its own transaction when it is not already inside one.

type AgentsShape = 'v02' | 'enrollment';

async function inTransaction(
  db: Kysely<any>,
  fn: (trx: Kysely<any> | Transaction<any>) => Promise<void>,
): Promise<void> {
  if (db.isTransaction) {
    await fn(db);
    return;
  }
  await db.transaction().execute(fn);
}

async function rebuildAgents(db: Kysely<any>, shape: AgentsShape): Promise<void> {
  const states =
    shape === 'enrollment'
      ? sql`state IN ('active', 'suspended', 'retired', 'revoked')`
      : sql`state IN ('active', 'suspended', 'revoked')`;

  await sql`DROP TABLE IF EXISTS agents_rebuild`.execute(db);

  let table = db.schema
    .createTable('agents_rebuild')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('colony_id', 'text', (col) => col.notNull().references('colonies.id'))
    .addColumn('owner_id', 'text', (col) => col.notNull().references('hivekeepers.id'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull().check(sql`type IN ('worker', 'scout')`))
    .addColumn('capabilities', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('instructions', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('active').check(states))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('revoked_at', 'text')
    .addColumn('last_connected_at', 'text');

  if (shape === 'enrollment') {
    table = table
      .addColumn('origin', 'text', (col) =>
        col
          .notNull()
          .defaultTo('manual')
          .check(sql`origin IN ('manual', 'enrollment')`),
      )
      .addColumn('enrolled_via', 'text')
      .addColumn('description', 'text')
      .addColumn('retired_at', 'text')
      .addColumn('last_worker_jti', 'text')
      .addCheckConstraint(
        'agents_enrolled_via_origin_check',
        sql`origin = 'enrollment' OR enrolled_via IS NULL`,
      )
      .addCheckConstraint(
        'agents_retired_at_state_check',
        sql`state = 'retired' OR retired_at IS NULL`,
      )
      .addCheckConstraint(
        'agents_description_length_check',
        sql`description IS NULL OR length(description) <= 280`,
      );
  }
  await table.execute();

  const shared = sql.raw(
    'id, hive_id, colony_id, owner_id, name, type, capabilities, instructions, state, ' +
      'created_at, revoked_at, last_connected_at',
  );
  await sql`INSERT INTO agents_rebuild (${shared}) SELECT ${shared} FROM agents`.execute(db);

  await sql`DROP TABLE agents`.execute(db);
  await sql`ALTER TABLE agents_rebuild RENAME TO agents`.execute(db);

  await sql`CREATE UNIQUE INDEX agents_owner_name_active_uq ON agents (owner_id, name) WHERE state != 'revoked'`.execute(
    db,
  );
  await sql`CREATE INDEX idx_agents_owner_active ON agents (owner_id, state) WHERE state = 'active'`.execute(
    db,
  );
  await sql`CREATE INDEX idx_agents_active_scouts ON agents (hive_id, type, state) WHERE type = 'scout' AND state = 'active'`.execute(
    db,
  );

  if (shape === 'enrollment') {
    // Quota count per enrollment credential.
    await sql`CREATE INDEX idx_agents_enrolled_via_active ON agents (enrolled_via) WHERE state = 'active'`.execute(
      db,
    );
    // Retirement pass of the retention job.
    await sql`CREATE INDEX idx_agents_enrollment_retirement ON agents (last_connected_at) WHERE origin = 'enrollment' AND state = 'active'`.execute(
      db,
    );
    // Grace-expiry pass of the retention job.
    await sql`CREATE INDEX idx_agents_retired_grace ON agents (retired_at) WHERE state = 'retired'`.execute(
      db,
    );
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await inTransaction(db, async (trx) => {
    await rebuildAgents(trx, 'enrollment');

    await trx.schema
      .alterTable('credentials')
      .addColumn('scope', 'text', (col) => col.check(sql`scope IS NULL OR scope = 'enroll'`))
      .execute();
    await trx.schema.alterTable('credentials').addColumn('enrolled_via', 'text').execute();
    // Revocation cascade and child-token lookups of an enrollment credential.
    await sql`CREATE INDEX idx_credentials_enrolled_via ON credentials (enrolled_via) WHERE enrolled_via IS NOT NULL`.execute(
      trx,
    );
  });
}

export async function down(db: Kysely<any>): Promise<void> {
  await inTransaction(db, async (trx) => {
    await sql`DROP INDEX IF EXISTS idx_credentials_enrolled_via`.execute(trx);
    await trx.schema.alterTable('credentials').dropColumn('enrolled_via').execute();
    await trx.schema.alterTable('credentials').dropColumn('scope').execute();

    // Fails on the old state CHECK while a `retired` agent exists: rolling back would
    // otherwise have to invent a state for it.
    await rebuildAgents(trx, 'v02');
  });
}
