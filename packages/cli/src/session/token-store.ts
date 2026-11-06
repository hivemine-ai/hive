// The last Worker token of a holder, persisted per project and name
// (`state/tokens/<project-key>/<name>.json`) so a restarted proxy renews instead
// of claiming. Only the process that holds the exclusive lock of the name reads
// or rewrites the file; the lock lives as long as the slot.

import { readPrivateJson, removePrivateFile, writePrivateJson } from './state-dir.js';
import type { StatePaths } from './state-dir.js';
import { tryExclusiveLock } from './token-lock.js';

/**
 * The server accepts an expired token as holder proof for
 * `HIVE_HOLDER_PROOF_WINDOW_DAYS` (default 7). The client does not read that
 * variable: a file older than the default window is not worth a renewal, and a
 * shorter server window just answers -32001, which falls back to enrollment.
 */
export const HOLDER_PROOF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface PersistedToken {
  version: 1;
  serverUrl: string;
  agentRef: string;
  agentId: string;
  token: string;
  expiresAt: string;
  updatedAt: string;
  /** Kept so a restarted proxy can renew without the model. */
  description?: string;
  capabilities?: string[];
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function parsePersistedToken(raw: unknown): PersistedToken | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) return undefined;
  for (const key of ['serverUrl', 'agentRef', 'agentId', 'token', 'expiresAt', 'updatedAt']) {
    if (!isString(r[key])) return undefined;
  }
  if (Number.isNaN(Date.parse(r['expiresAt'] as string))) return undefined;
  const parsed: PersistedToken = {
    version: 1,
    serverUrl: r['serverUrl'] as string,
    agentRef: r['agentRef'] as string,
    agentId: r['agentId'] as string,
    token: r['token'] as string,
    expiresAt: r['expiresAt'] as string,
    updatedAt: r['updatedAt'] as string,
  };
  if (isString(r['description'])) parsed.description = r['description'];
  const caps = r['capabilities'];
  if (Array.isArray(caps) && caps.every((c) => typeof c === 'string')) {
    parsed.capabilities = caps;
  }
  return parsed;
}

export function isUsableToken(token: PersistedToken, serverUrl: string, now: number): boolean {
  return (
    token.serverUrl === serverUrl && Date.parse(token.expiresAt) + HOLDER_PROOF_WINDOW_MS > now
  );
}

export interface TokenSlot {
  readonly name: string;
  read(): PersistedToken | undefined;
  write(token: PersistedToken): void;
  remove(): void;
  release(): void;
}

/** Takes the lock of `name` in this project, or undefined if another holder has it. */
export function openTokenSlot(
  paths: StatePaths,
  projectKey: string,
  name: string,
): TokenSlot | undefined {
  const lock = tryExclusiveLock(paths.tokenLock(projectKey, name));
  if (lock === undefined) return undefined;
  const file = paths.tokenFile(projectKey, name);
  return {
    name,
    read: () => parsePersistedToken(readPrivateJson(file)),
    write: (token) => writePrivateJson(file, token),
    remove: () => removePrivateFile(file),
    release: () => lock.release(),
  };
}
