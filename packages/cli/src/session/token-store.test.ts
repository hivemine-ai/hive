import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { statePaths } from './state-dir.js';
import { isUsableToken, openTokenSlot, parsePersistedToken } from './token-store.js';
import type { PersistedToken } from './token-store.js';
import { tryExclusiveLock } from './token-lock.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-token-'));
  chmodSync(dir, 0o700);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

function token(overrides: Partial<PersistedToken> = {}): PersistedToken {
  return {
    version: 1,
    serverUrl: 'http://hive.test/mcp',
    agentRef: 'claude-api@leo.hive',
    agentId: '0190a000-0000-7000-8000-000000000001',
    token: 'worker-token',
    expiresAt: new Date(10 * DAY).toISOString(),
    updatedAt: new Date(0).toISOString(),
    description: 'Works on the API',
    ...overrides,
  };
}

/** Holds the lock in another process until killed. Resolves once it holds it. */
async function holdInChild(path: string): Promise<ChildProcess> {
  const lockModule = new URL('../../dist/session/token-lock.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { tryExclusiveLock } = await import(${JSON.stringify(lockModule)});
       const held = tryExclusiveLock(${JSON.stringify(path)});
       process.stdout.write(held ? 'held\\n' : 'busy\\n');
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.push(child);
  const first = await new Promise<string>((resolve) => {
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
  });
  expect(first).toBe('held');
  return child;
}

describe('tryExclusiveLock', () => {
  it('creates a 0600 lock file and refuses a second holder in the same process', () => {
    const path = join(dir, 'tokens', 'a.lock');
    const first = tryExclusiveLock(path);
    expect(first).toBeDefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(tryExclusiveLock(path)).toBeUndefined();
    first?.release();
    const again = tryExclusiveLock(path);
    expect(again).toBeDefined();
    again?.release();
  });

  it('refuses the lock while another live process holds it', async () => {
    const path = join(dir, 'a.lock');
    await holdInChild(path);
    expect(tryExclusiveLock(path)).toBeUndefined();
  });

  it('the OS releases the lock when the holder is killed with SIGKILL', async () => {
    const path = join(dir, 'a.lock');
    const child = await holdInChild(path);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    const taken = tryExclusiveLock(path);
    expect(taken).toBeDefined();
    taken?.release();
  });
});

describe('parsePersistedToken / isUsableToken', () => {
  it('accepts a well-formed token file and rejects anything else', () => {
    expect(parsePersistedToken(token())).toEqual(token());
    expect(parsePersistedToken({ ...token(), token: 3 })).toBeUndefined();
    expect(parsePersistedToken({ ...token(), version: 2 })).toBeUndefined();
    expect(parsePersistedToken(null)).toBeUndefined();
  });

  it('is usable for the same server until its expiry plus the holder-proof window', () => {
    const t = token({ expiresAt: new Date(1 * DAY).toISOString() });
    expect(isUsableToken(t, 'http://hive.test/mcp', 1 * DAY + 6 * DAY)).toBe(true);
    expect(isUsableToken(t, 'http://hive.test/mcp', 1 * DAY + 7 * DAY + 1)).toBe(false);
    expect(isUsableToken(t, 'http://other.test/mcp', 0)).toBe(false);
  });
});

describe('openTokenSlot', () => {
  const paths = () => statePaths(dir);

  it('reads, rewrites and removes the token under its lock', () => {
    const slot = openTokenSlot(paths(), 'k', 'claude-api');
    expect(slot).toBeDefined();
    expect(slot?.read()).toBeUndefined();
    slot?.write(token());
    expect(statSync(paths().tokenFile('k', 'claude-api')).mode & 0o777).toBe(0o600);
    expect(slot?.read()).toEqual(token());
    slot?.remove();
    expect(existsSync(paths().tokenFile('k', 'claude-api'))).toBe(false);
    slot?.release();
  });

  it('is unavailable while another holder has the name', () => {
    const first = openTokenSlot(paths(), 'k', 'claude-api');
    expect(openTokenSlot(paths(), 'k', 'claude-api')).toBeUndefined();
    expect(openTokenSlot(paths(), 'k', 'other')).toBeDefined();
    first?.release();
  });

  it('treats a malformed token file as absent', () => {
    const slot = openTokenSlot(paths(), 'k', 'claude-api');
    writeFileSync(paths().tokenFile('k', 'claude-api'), '{"version":1}', { mode: 0o600 });
    expect(slot?.read()).toBeUndefined();
    slot?.release();
  });
});
