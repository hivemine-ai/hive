import { createRequire } from 'node:module';

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import type * as Pg from 'pg';

import { parseBoolEnv, parseIntEnv } from '#observability/env.js';

import type { Database } from './schema.js';

export type DbDialect = 'sqlite' | 'postgres';

export interface DbConfig {
  dialect: DbDialect;
  url: string;
  // SQLite-only: enable WAL journal mode. Default true (skipped for `:memory:`).
  sqliteWal?: boolean;
  // Postgres-only: connection pool size. Default 10.
  postgresPoolSize?: number;
}

export function resolveDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const explicitDialect = env['HIVE_DB_DIALECT']?.toLowerCase();
  const url = env['HIVE_DB_URL'] ?? 'sqlite:./var/db/hive.sqlite';

  let dialect: DbDialect;
  if (explicitDialect === 'sqlite' || explicitDialect === 'postgres') {
    dialect = explicitDialect;
  } else if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    dialect = 'postgres';
  } else if (url.startsWith('sqlite:')) {
    dialect = 'sqlite';
  } else {
    throw new Error(
      `Cannot infer DB dialect from HIVE_DB_URL='${url}'. ` +
        `Set HIVE_DB_DIALECT explicitly to 'sqlite' or 'postgres'.`,
    );
  }

  const cfg: DbConfig = {
    dialect,
    url,
    sqliteWal: parseBoolEnv(env['HIVE_DB_SQLITE_WAL'], true, { name: 'HIVE_DB_SQLITE_WAL' }),
  };

  const poolSize = env['HIVE_DB_POOL_SIZE'];
  if (poolSize !== undefined && poolSize !== '') {
    cfg.postgresPoolSize = parseIntEnv(poolSize, 0, {
      name: 'HIVE_DB_POOL_SIZE',
      min: 1,
    });
  }

  return cfg;
}

export function createDb(config?: DbConfig): Kysely<Database> {
  const cfg = config ?? resolveDbConfigFromEnv();
  if (cfg.dialect === 'sqlite') {
    return createSqliteDb(cfg);
  }
  return createPostgresDb(cfg);
}

function createSqliteDb(cfg: DbConfig): Kysely<Database> {
  const path = stripSqliteUrlPrefix(cfg.url);
  const sqliteDb = new BetterSqlite3(path);
  sqliteDb.pragma('foreign_keys = ON');
  if (cfg.sqliteWal !== false && path !== ':memory:') {
    sqliteDb.pragma('journal_mode = WAL');
  }
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqliteDb }),
  });
}

function createPostgresDb(cfg: DbConfig): Kysely<Database> {
  // Lazy require so SQLite-only deployments don't pay the import cost,
  // and so installations without `pg` get a clear error message instead of
  // a generic "module not found" at startup.
  const requireFn = createRequire(import.meta.url);
  let pgModule: typeof Pg;
  try {
    pgModule = requireFn('pg') as typeof Pg;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Postgres dialect requires the 'pg' package. ` +
        `Run 'pnpm install pg' or set HIVE_DB_DIALECT=sqlite. Underlying error: ${reason}`,
    );
  }
  const pool = new pgModule.Pool({
    connectionString: cfg.url,
    max: cfg.postgresPoolSize ?? 10,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

function stripSqliteUrlPrefix(url: string): string {
  if (url.startsWith('sqlite:')) {
    return url.slice('sqlite:'.length);
  }
  return url;
}
