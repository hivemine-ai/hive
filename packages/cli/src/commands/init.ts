// `hivectl init --admin-email <email> [--hive-name <name>] [--ttl <duration>] [--db <url>]`
//
// Per the tech spec § Diagrama "Bootstrap (`hivectl init`)":
//   1. Open DB.
//   2. Run migrations (`Kysely.Migrator.migrateToLatest()`).
//   3. Acquire `hive_init` distributed lock (race guard).
//   4. Re-check no Hive row exists.
//   5. Generate Ed25519 keypair + write PEM 0600 + insert signing_keys row.
//   6. Insert hives + colonies + first admin Hivekeeper + admin Cell in one TX.
//   7. Issue first credential.
//   8. Return result; CLI handler prints summary + writes JWT to file or stdout.
//
// This command BYPASSES `wire.startCli()` because the schema and signing keys
// don't exist yet — the wire would fail loading them.

import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { performInit } from '../init.js';
import type { InitResult } from '../init.js';
import { CliError } from '../error/cli-error.js';
import { parseDuration } from '../input/parse-duration.js';
import type { GlobalCliOpts } from '../types.js';

export interface InitCommandOpts {
  globals: GlobalCliOpts;
  adminEmail: string;
  adminDisplayName: string | undefined;
  hiveName: string | undefined;
  /** Database URL or 'sqlite:./var/db/hive.sqlite' default. */
  db: string;
  /** Directory for signing key PEMs. Default './var/keys'. */
  keysDir: string;
  /** TTL for the bootstrap credential in duration format ('365d', '12h', etc.). */
  ttl: string | undefined;
  /** If set, write the JWT to this file (perms 0600). Otherwise stdout. */
  outputCredential: string | undefined;
}

export interface InitCommandResult {
  hiveId: string;
  hiveName: string;
  adminEmail: string;
  adminId: string;
  signingKeyKid: string;
  credentialJti: string;
  credentialExpiresAt: Date;
  credentialPath: string | null;
  /** JWT inline only when `outputCredential` is null. */
  credentialJwt?: string;
}

export async function runInit(opts: InitCommandOpts): Promise<InitCommandResult> {
  if (!isPlausibleEmail(opts.adminEmail)) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'admin_email_invalid',
      message: `'${opts.adminEmail}' is not a valid email`,
    });
  }

  // Bootstrap UX (PRY-036): auto-create parent dirs of every path the
  // bootstrap will write to. Without this, a first-run from an empty cwd
  // (e.g. `hivectl init` straight after `npm install -g`) crashed with
  // `internal error: Cannot open database because the directory does not
  // exist`. mkdir is idempotent (recursive + EEXIST tolerated). Postgres
  // URLs are skipped — that DB is managed externally.
  const sqlitePath = extractSqlitePathFromUrl(opts.db);
  if (sqlitePath !== null) {
    await mkdir(path.dirname(sqlitePath), { recursive: true });
  }
  await mkdir(opts.keysDir, { recursive: true });
  if (opts.outputCredential !== undefined && opts.outputCredential !== '') {
    await mkdir(path.dirname(opts.outputCredential), { recursive: true });
  }

  const ttlMs = opts.ttl !== undefined ? parseDuration(opts.ttl) : undefined;

  const initOpts: Parameters<typeof performInit>[0] = {
    db: opts.db,
    adminEmail: opts.adminEmail,
    keysDir: opts.keysDir,
  };
  if (opts.hiveName !== undefined) initOpts.hiveName = opts.hiveName;
  if (opts.adminDisplayName !== undefined) initOpts.adminDisplayName = opts.adminDisplayName;
  if (ttlMs !== undefined) initOpts.ttlMs = ttlMs;
  if (opts.globals.operatorNote !== undefined) initOpts.operatorNote = opts.globals.operatorNote;
  const osUser = process.env['USER'];
  if (osUser !== undefined && osUser !== '') initOpts.osUser = osUser;

  const result: InitResult = await performInit(initOpts);

  let credentialPath: string | null = null;
  if (opts.outputCredential !== undefined && opts.outputCredential !== '') {
    writeFileSync(opts.outputCredential, result.initialCredential.jwt, { mode: 0o600 });
    credentialPath = opts.outputCredential;
  }

  const summary: InitCommandResult = {
    hiveId: result.hiveId,
    hiveName: opts.hiveName ?? 'Hive',
    adminEmail: opts.adminEmail,
    adminId: result.adminHivekeeperId,
    signingKeyKid: result.signingKey.kid,
    credentialJti: result.initialCredential.jti,
    credentialExpiresAt: result.initialCredential.expiresAt,
    credentialPath,
  };
  if (credentialPath === null) {
    summary.credentialJwt = result.initialCredential.jwt;
  }
  return summary;
}

function isPlausibleEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

/**
 * Returns the filesystem path of a `sqlite:` DB URL, or null if the URL is
 * not SQLite (e.g. `postgres://...`). Used by `runInit` to know whether to
 * pre-create the parent directory before opening the file.
 */
export function extractSqlitePathFromUrl(url: string): string | null {
  return url.startsWith('sqlite:') ? url.slice('sqlite:'.length) : null;
}
