import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { createDb, resolveDbConfigFromEnv } from './db.js';
import type { DbConfig } from './db.js';

describe('resolveDbConfigFromEnv', () => {
  it('defaults to SQLite at ./var/db/hive.sqlite when nothing is set', () => {
    const cfg = resolveDbConfigFromEnv({});
    expect(cfg.dialect).toBe('sqlite');
    expect(cfg.url).toBe('sqlite:./var/db/hive.sqlite');
  });

  it('infers postgres dialect from postgres:// URL', () => {
    const cfg = resolveDbConfigFromEnv({
      HIVE_DB_URL: 'postgres://u:p@h:5432/d',
    });
    expect(cfg.dialect).toBe('postgres');
  });

  it('infers postgres dialect from postgresql:// URL', () => {
    const cfg = resolveDbConfigFromEnv({
      HIVE_DB_URL: 'postgresql://u:p@h:5432/d',
    });
    expect(cfg.dialect).toBe('postgres');
  });

  it('honors explicit HIVE_DB_DIALECT over URL prefix', () => {
    const cfg = resolveDbConfigFromEnv({
      HIVE_DB_DIALECT: 'sqlite',
      HIVE_DB_URL: 'postgres://u:p@h:5432/d',
    });
    expect(cfg.dialect).toBe('sqlite');
  });

  it('throws when URL prefix is unknown and dialect is not set', () => {
    expect(() => resolveDbConfigFromEnv({ HIVE_DB_URL: 'mysql://...' })).toThrow(
      /Cannot infer DB dialect/,
    );
  });

  it('parses HIVE_DB_POOL_SIZE as integer', () => {
    const cfg = resolveDbConfigFromEnv({
      HIVE_DB_DIALECT: 'postgres',
      HIVE_DB_URL: 'postgres://h/d',
      HIVE_DB_POOL_SIZE: '25',
    });
    expect(cfg.postgresPoolSize).toBe(25);
  });

  it('rejects non-numeric HIVE_DB_POOL_SIZE', () => {
    expect(() =>
      resolveDbConfigFromEnv({
        HIVE_DB_DIALECT: 'postgres',
        HIVE_DB_URL: 'postgres://h/d',
        HIVE_DB_POOL_SIZE: 'abc',
      }),
    ).toThrow(/HIVE_DB_POOL_SIZE must be an integer/);
  });

  it('rejects zero or negative HIVE_DB_POOL_SIZE', () => {
    expect(() =>
      resolveDbConfigFromEnv({
        HIVE_DB_DIALECT: 'postgres',
        HIVE_DB_URL: 'postgres://h/d',
        HIVE_DB_POOL_SIZE: '0',
      }),
    ).toThrow(/HIVE_DB_POOL_SIZE must be >= 1/);
  });

  it('rejects fractional HIVE_DB_POOL_SIZE (carry-over PRY-005 N5)', () => {
    expect(() =>
      resolveDbConfigFromEnv({
        HIVE_DB_DIALECT: 'postgres',
        HIVE_DB_URL: 'postgres://h/d',
        HIVE_DB_POOL_SIZE: '1.5',
      }),
    ).toThrow(/HIVE_DB_POOL_SIZE must be an integer/);
  });

  it('disables sqliteWal when HIVE_DB_SQLITE_WAL=false', () => {
    const cfg = resolveDbConfigFromEnv({ HIVE_DB_SQLITE_WAL: 'false' });
    expect(cfg.sqliteWal).toBe(false);
  });
});

describe('createDb (SQLite in-memory smoke)', () => {
  const dbs: Awaited<ReturnType<typeof createDb>>[] = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      const db = dbs.pop()!;
      await db.destroy();
    }
  });

  it('creates a working Kysely instance against :memory: SQLite', async () => {
    const cfg: DbConfig = { dialect: 'sqlite', url: 'sqlite::memory:' };
    const db = createDb(cfg);
    dbs.push(db);

    // Run a trivial query that doesn't depend on schema.
    const result = await sql<{ value: number }>`SELECT 1 AS value`.execute(db);
    expect(result.rows[0]?.value).toBe(1);
  });

  it('honors foreign_keys=ON pragma on SQLite', async () => {
    const cfg: DbConfig = { dialect: 'sqlite', url: 'sqlite::memory:' };
    const db = createDb(cfg);
    dbs.push(db);

    const result = await sql<{
      foreign_keys: number;
    }>`PRAGMA foreign_keys`.execute(db);
    expect(result.rows[0]?.foreign_keys).toBe(1);
  });
});
