// User state of the named-session clients (ADR-026): everything lives under
// `~/.config/hive/` (override `HIVE_CONFIG_DIR`), never inside a project.
// Directories are 0700 and files 0600; a laxer mode fails fast on read, the
// same rule `watch` applies to its credential. Writes are atomic (temporary
// file + rename) so no reader ever sees half a file.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const GROUP_OR_OTHER = 0o077;

export type SessionStateErrorCode = 'SESSION_STATE_INSECURE_PERMS' | 'SESSION_STATE_INVALID';

export class SessionStateError extends Error {
  readonly code: SessionStateErrorCode;

  constructor(code: SessionStateErrorCode, message: string) {
    super(message);
    this.name = 'SessionStateError';
    this.code = code;
  }
}

export function configRoot(env: NodeJS.ProcessEnv, home: string): string {
  const override = env['HIVE_CONFIG_DIR'];
  return override !== undefined && override !== '' ? override : join(home, '.config', 'hive');
}

/** Hash of the real path of the project folder. Exact match, no parent walk. */
export function projectKey(projectPath: string): string {
  return createHash('sha256').update(realpathSync(projectPath)).digest('hex').slice(0, 32);
}

const PLAIN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * A session name as a file name. Names come from the model, so anything that is
 * not a plain name is hashed: no name can escape its directory.
 */
export function fileSegment(name: string): string {
  if (PLAIN_SEGMENT.test(name)) return name;
  return `h-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
}

export interface StatePaths {
  readonly root: string;
  enrollment(projectKey: string): string;
  enrollmentDir: string;
  sessionsDir(projectKey: string): string;
  pidMap(claudePid: number): string;
  proxy(claudePid: number): string;
  tokensDir(projectKey: string): string;
  tokenFile(projectKey: string, name: string): string;
  tokenLock(projectKey: string, name: string): string;
}

export function statePaths(root: string): StatePaths {
  const state = join(root, 'state');
  return {
    root,
    enrollment: (key) => join(root, 'enrollment', `${key}.json`),
    enrollmentDir: join(root, 'enrollment'),
    sessionsDir: (key) => join(state, 'sessions', key),
    pidMap: (pid) => join(state, 'pid-map', `${String(pid)}.json`),
    proxy: (pid) => join(state, 'proxies', `${String(pid)}.json`),
    tokensDir: (key) => join(state, 'tokens', key),
    tokenFile: (key, name) => join(state, 'tokens', key, `${fileSegment(name)}.json`),
    tokenLock: (key, name) => join(state, 'tokens', key, `${fileSegment(name)}.lock`),
  };
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode;
  } catch {
    return undefined;
  }
}

function assertPrivateDir(dir: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  const mode = modeOf(dir);
  if (mode !== undefined && (mode & GROUP_OR_OTHER) !== 0) {
    throw new SessionStateError(
      'SESSION_STATE_INSECURE_PERMS',
      `${dir} must be accessible by its owner only (chmod 700)`,
    );
  }
}

/** Creates the directory (and missing parents) as 0700; an existing laxer one fails. */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir, platform);
}

/** Reads a JSON state file. Missing → undefined; laxer than 0600 → SESSION_STATE_INSECURE_PERMS. */
export function readPrivateJson(
  path: string,
  platform: NodeJS.Platform = process.platform,
): unknown {
  const mode = modeOf(path);
  if (mode === undefined) return undefined;
  if (platform !== 'win32' && (mode & GROUP_OR_OTHER) !== 0) {
    throw new SessionStateError(
      'SESSION_STATE_INSECURE_PERMS',
      `${path} must be readable by its owner only (chmod 600)`,
    );
  }
  assertPrivateDir(dirname(path), platform);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SessionStateError('SESSION_STATE_INVALID', `${path} is not valid JSON`);
  }
}

export function writePrivateJson(
  path: string,
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): void {
  const dir = dirname(path);
  ensurePrivateDir(dir, platform);
  const temporary = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (err) {
    removePrivateFile(temporary);
    throw err;
  }
}

export function removePrivateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
