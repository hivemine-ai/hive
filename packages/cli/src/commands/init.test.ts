// PRY-036 — `hivectl init` auto-mkdir parent dirs of --db (SQLite) +
// --keys-dir + --output-credential.
//
// PRY-052 — ceremonial output (banner + 5-step + framed credential) +
// re-run fail-fast against an existing hive + `--output-credential`
// suppresses stdout token rendering.
//
// Pure helper tests for `extractSqlitePathFromUrl`, plus integration tests
// that exercise `runInit` from an empty tmpdir without pre-creating the
// var/db / var/keys directories — the scenario that crashed pre-PRY-036
// with `internal error: Cannot open database because the directory does
// not exist`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractSqlitePathFromUrl, runInit } from './init.js';
import type { CeremonialSink } from '#output/init-ceremonial.js';
import type { GlobalCliOpts } from '../types.js';

function bufferSink(): CeremonialSink & { read(): string } {
  const chunks: string[] = [];
  return {
    write(s: string): void {
      chunks.push(s);
    },
    read(): string {
      return chunks.join('');
    },
  };
}

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

function makePrettyGlobals(): GlobalCliOpts {
  return {
    output: 'table',
    yes: true,
    noColor: true,
    verbose: false,
  };
}

describe('PRY-052 — runInit ceremonial output (pretty mode)', () => {
  let workDir: string;
  let originalCwd: string;
  const previousLevel = chalk.level;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(path.join(tmpdir(), 'pry-052-'));
    process.chdir(workDir);
    chalk.level = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    chalk.level = previousLevel;
  });

  it('emits banner + 5 step rows + framed credential box when no --output-credential', async () => {
    const sink = bufferSink();
    await runInit({
      globals: makePrettyGlobals(),
      adminEmail: 'admin@example.com',
      adminDisplayName: undefined,
      hiveName: 'Foo',
      db: 'sqlite:./hive.sqlite',
      keysDir: './keys',
      ttl: '365d',
      outputCredential: undefined,
      ceremonialSink: sink,
    });

    const out = sink.read();
    // Banner: 5 expanded lines (the `⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢` cluster only
    // appears in the expanded form — line 3 with 8 hexagons).
    expect(out).toContain('⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢');
    // All 5 step labels in order.
    expect(out).toMatch(/\[1\/5\] database\s+✓ opened/);
    expect(out).toMatch(/\[2\/5\] migrations\s+✓ applied \d+ migrations?/);
    expect(out).toMatch(/\[3\/5\] signing key\s+✓ generated kid [0-9a-f]{12}/);
    expect(out).toMatch(/\[4\/5\] admin hivekeeper\s+✓ created [0-9a-f]{8} — admin@example.com/);
    expect(out).toMatch(/\[5\/5\] root credential\s+✓ issued jti [0-9a-f]{8} \(ttl \d+d\)/);
    // Step rows must appear in 1→5 order.
    const positions = [1, 2, 3, 4, 5].map((n) => out.indexOf(`[${n}/5]`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Framed credential box: warning + frame chars.
    expect(out).toContain('save this token now — it is shown only once');
    expect(out).toMatch(/┌─{65}┐/);
    expect(out).toMatch(/└─{65}┘/);
    // The JWT itself (always starts with `eyJ` for an EdDSA-signed token).
    expect(out).toContain('eyJ');
  });

  it('replaces the framed box with a written-confirmation when --output-credential is set', async () => {
    const sink = bufferSink();
    const credentialPath = './secrets/admin.jwt';
    await runInit({
      globals: makePrettyGlobals(),
      adminEmail: 'admin@example.com',
      adminDisplayName: undefined,
      hiveName: 'Foo',
      db: 'sqlite:./hive.sqlite',
      keysDir: './keys',
      ttl: '365d',
      outputCredential: credentialPath,
      ceremonialSink: sink,
    });

    const out = sink.read();
    // The 5-step block still renders.
    expect(out).toMatch(/\[5\/5\] root credential\s+✓ issued jti/);
    // Written confirmation present (path is interpolated verbatim).
    expect(out).toContain('root credential written to ./secrets/admin.jwt');
    expect(out).toContain('this token is the ONLY admin credential — keep the file safe');
    // The token MUST NOT appear on stdout.
    expect(out).not.toContain('eyJ');
    // The framed box MUST NOT appear (no warning, no frame chars).
    expect(out).not.toContain('save this token now');
    expect(out).not.toMatch(/┌─{65}┐/);
    // The file MUST contain the JWT.
    const written = readFileSync(credentialPath, 'utf8');
    expect(written.startsWith('eyJ')).toBe(true);
  });

  it('keeps stdout silent in JSON mode (no banner, no steps, no box)', async () => {
    const sink = bufferSink();
    await runInit({
      globals: makeGlobals(), // output: 'json'
      adminEmail: 'admin@example.com',
      adminDisplayName: undefined,
      hiveName: 'Foo',
      db: 'sqlite:./hive.sqlite',
      keysDir: './keys',
      ttl: '365d',
      outputCredential: undefined,
      ceremonialSink: sink,
    });
    expect(sink.read()).toBe('');
  });

  it('rejects re-runs against an already-initialised hive with HIVE_ALREADY_INITIALIZED + exit-1 mapping', async () => {
    // First init succeeds.
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'admin@example.com',
      adminDisplayName: undefined,
      hiveName: 'Foo',
      db: 'sqlite:./hive.sqlite',
      keysDir: './keys',
      ttl: undefined,
      outputCredential: undefined,
    });

    // Second init throws — the error code maps to exit 1 in
    // `error/handler.ts`. Ceremonial steps that succeeded before the
    // throw (database, migrations) ARE rendered; subsequent ones are
    // not. The user sees the partial flow + the `error: ...` line
    // emitted by `runHandler`.
    const sink = bufferSink();
    await expect(
      runInit({
        globals: makePrettyGlobals(),
        adminEmail: 'admin@example.com',
        adminDisplayName: undefined,
        hiveName: 'Foo',
        db: 'sqlite:./hive.sqlite',
        keysDir: './keys',
        ttl: undefined,
        outputCredential: undefined,
        ceremonialSink: sink,
      }),
    ).rejects.toMatchObject({ code: 'HIVE_ALREADY_INITIALIZED' });

    const out = sink.read();
    // The boot banner + the early phases that succeeded (database +
    // migrations) appear; signing-key onwards do not.
    expect(out).toContain('⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢');
    expect(out).toMatch(/\[1\/5\] database/);
    expect(out).toMatch(/\[2\/5\] migrations/);
    expect(out).not.toMatch(/\[3\/5\] signing key/);
    expect(out).not.toMatch(/\[5\/5\] root credential/);
  });
});
