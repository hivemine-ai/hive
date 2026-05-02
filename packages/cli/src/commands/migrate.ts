// `hivectl migrate up | down | status` — wraps Kysely.Migrator. Per ADR-008
// the CLI uses Kysely's portable migration runner, NOT node-pg-migrate (which
// is Postgres-only). Same migrations work on SQLite (default) and Postgres.
//
// `migrate up` does NOT require `--yes`; rolling forward is reversible only
// in the sense that a `down` exists. `migrate down` requires `--yes` because
// rolling back may drop tables.
//
// This command bypasses `wire.startCli()` — the schema may not exist yet, so
// the regular wire would fail loading hives + signing keys.

import { createDb, migrateDown, migrateToLatest } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import type { GlobalCliOpts } from '../types.js';

export type MigrateAction = 'up' | 'down' | 'status';

export interface MigrateOpts {
  globals: GlobalCliOpts;
  action: MigrateAction;
}

export interface MigrateResult {
  action: MigrateAction;
  applied: { name: string; status: 'success' | 'noop' }[];
}

export async function performMigrate(opts: MigrateOpts): Promise<MigrateResult> {
  if (opts.action === 'down' && !opts.globals.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: "'migrate down' is destructive; pass --yes to confirm",
    });
  }

  const db = createDb();
  try {
    if (opts.action === 'status') {
      // Status reports applied migrations from Kysely's internal table.
      // Each migration row has only `name` (the timestamp_label) — we report
      // them in lexicographic order which matches application order.
      const rows = await tryListMigrations(db);
      return { action: 'status', applied: rows };
    }
    if (opts.action === 'up') {
      const result = await migrateToLatest(db);
      const applied = (result.results ?? []).map((r) => ({
        name: r.migrationName,
        status: r.status === 'Success' ? ('success' as const) : ('noop' as const),
      }));
      return { action: 'up', applied };
    }
    if (opts.action === 'down') {
      const result = await migrateDown(db);
      const applied = (result.results ?? []).map((r) => ({
        name: r.migrationName,
        status: r.status === 'Success' ? ('success' as const) : ('noop' as const),
      }));
      return { action: 'down', applied };
    }
    const exhaustive: never = opts.action;
    throw new CliError('CONFIG_INVALID', {
      subCode: 'unknown_action',
      message: `unknown migrate action: ${String(exhaustive)}`,
    });
  } finally {
    await db.destroy();
  }
}

async function tryListMigrations(
  db: ReturnType<typeof createDb>,
): Promise<{ name: string; status: 'success' | 'noop' }[]> {
  try {
    const rows = await db
      // The migration table name is owned by Kysely.Migrator; default name is
      // `kysely_migration`. If the table does not exist, the query throws.
      .selectFrom('kysely_migration' as never)
      .select(['name'] as never)
      .orderBy('name' as never, 'asc')
      .execute();
    return (rows as { name: string }[]).map((r) => ({ name: r.name, status: 'success' as const }));
  } catch (err) {
    // Distinguish "table does not exist" (expected before first migration) from
    // other failures (perms, schema mismatch, network) — the latter must surface
    // so the operator does not see a misleading "0 migrations" output.
    if (isTableMissingError(err)) {
      return [];
    }
    throw err;
  }
}

function isTableMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // SQLite: "no such table: kysely_migration"
  // Postgres: "relation \"kysely_migration\" does not exist"
  return (
    msg.includes('no such table') ||
    msg.includes('does not exist') ||
    msg.includes('undefined table')
  );
}
