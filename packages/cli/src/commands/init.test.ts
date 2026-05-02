// PRY-036 — `hivectl init` auto-mkdir parent dirs of --db (SQLite) +
// --keys-dir + --output-credential.
//
// Pure helper tests for `extractSqlitePathFromUrl`, plus integration tests
// that exercise `runInit` from an empty tmpdir without pre-creating the
// var/db / var/keys directories — the scenario that crashed pre-PRY-036
// with `internal error: Cannot open database because the directory does
// not exist`.

import { existsSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractSqlitePathFromUrl, runInit } from './init.js';
import type { GlobalCliOpts } from '../types.js';

describe('PRY-036 — extractSqlitePathFromUrl', () => {
  it('returns the filesystem path when the URL has the sqlite: prefix', () => {
    expect(extractSqlitePathFromUrl('sqlite:./var/db/hive.sqlite')).toBe('./var/db/hive.sqlite');
  });

  it('returns the filesystem path for an absolute sqlite URL', () => {
    expect(extractSqlitePathFromUrl('sqlite:/tmp/hive.sqlite')).toBe('/tmp/hive.sqlite');
  });

  it('returns null for postgres URLs', () => {
    expect(extractSqlitePathFromUrl('postgres://localhost:5432/hive')).toBeNull();
  });

  it('returns null for an unrecognized prefix', () => {
    expect(extractSqlitePathFromUrl('mysql://localhost/hive')).toBeNull();
  });
});

describe('PRY-036 — runInit auto-creates parent directories', () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(path.join(tmpdir(), 'pry-036-'));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('creates --db SQLite parent dir + --keys-dir + --output-credential parent dir end-to-end from an empty tmpdir', async () => {
    const dbPath = './nested/db/hive.sqlite';
    const keysDir = './nested/keys';
    const credentialPath = './nested/creds/admin.jwt';

    const result = await runInit({
      globals: makeGlobals(),
      adminEmail: 'pry036@example.com',
      adminDisplayName: undefined,
      hiveName: undefined,
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: undefined,
      outputCredential: credentialPath,
    });

    expect(result.adminEmail).toBe('pry036@example.com');
    expect(result.credentialPath).toBe(credentialPath);

    expect(existsSync(path.dirname(dbPath))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(keysDir).isDirectory()).toBe(true);
    expect(existsSync(credentialPath)).toBe(true);
  });

  it('does NOT attempt to mkdir for postgres URLs (no host filesystem touched)', () => {
    // Postgres flow would require a live server; we only assert the helper
    // does not crash trying to mkdir parts of the URL host. The init call
    // itself will fail when better-sqlite3 / pg can't connect — that's
    // expected and out of scope for this test. We test the mkdir-skip
    // contract by calling the helper directly.
    expect(extractSqlitePathFromUrl('postgres://localhost:5432/hive')).toBeNull();

    // Sanity: no `localhost` directory was created in the cwd as a side
    // effect of any future code path that might naively path-split a
    // postgres URL.
    expect(existsSync('./localhost:5432')).toBe(false);
    expect(existsSync('./localhost')).toBe(false);
  });

  it('omitting --output-credential still bootstraps cleanly (only db + keys-dir parents created)', async () => {
    const dbPath = './a/b/c/hive.sqlite';
    const keysDir = './a/b/keys';

    const result = await runInit({
      globals: makeGlobals(),
      adminEmail: 'pry036b@example.com',
      adminDisplayName: undefined,
      hiveName: undefined,
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: undefined,
      outputCredential: undefined,
    });

    expect(result.credentialPath).toBeNull();
    expect(result.credentialJwt).toMatch(/^eyJ/);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(keysDir).isDirectory()).toBe(true);
  });
});

function makeGlobals(): GlobalCliOpts {
  return {
    output: 'json',
    yes: true,
    noColor: true,
    verbose: false,
  };
}
