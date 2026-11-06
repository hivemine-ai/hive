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

import { createDb, getSchemaStatus, migrateDown, migrateToLatest } from '@hive/server';

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
  /** `status` only: catalog migrations not applied yet. */
  pending?: string[];
  /** `status` only: applied migrations this binary does not know (a newer hivectl ran them). */
  unknown?: string[];
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
      // Read-only: the migration table is read, never created (PRY-096).
      const status = await getSchemaStatus(db);
      return {
        action: 'status',
        applied: status.applied.map((name) => ({ name, status: 'success' as const })),
        pending: status.pending,
        unknown: status.unknown,
      };
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
