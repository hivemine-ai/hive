import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SessionStateError,
  configRoot,
  fileSegment,
  projectKey,
  readPrivateJson,
  removePrivateFile,
  statePaths,
  writePrivateJson,
} from './state-dir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-state-'));
  chmodSync(dir, 0o700);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('configRoot', () => {
  it('honours HIVE_CONFIG_DIR', () => {
    expect(configRoot({ HIVE_CONFIG_DIR: '/x/y' }, '/home/u')).toBe('/x/y');
  });

  it('defaults to ~/.config/hive', () => {
    expect(configRoot({}, '/home/u')).toBe('/home/u/.config/hive');
  });
});

describe('projectKey', () => {
  it('hashes the real path, so a symlink and its target share the key', () => {
    const real = join(dir, 'project');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    expect(projectKey(link)).toBe(projectKey(real));
    expect(projectKey(real)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives different folders different keys (no parent walk)', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    expect(projectKey(join(dir, 'a'))).not.toBe(projectKey(join(dir, 'a', 'b')));
  });
});

describe('fileSegment', () => {
  it('keeps a plain session name readable', () => {
    expect(fileSegment('claude-api')).toBe('claude-api');
  });

  it('never lets a name escape its directory', () => {
    for (const name of ['..', '.', '../x', 'a/b', '', 'x\u0000y']) {
      const segment = fileSegment(name);
      expect(segment).toMatch(/^h-[0-9a-f]{32}$/);
    }
  });
});

describe('statePaths', () => {
  it('lays out the user state under the root', () => {
    const paths = statePaths('/r');
    expect(paths.enrollment('k')).toBe('/r/enrollment/k.json');
    expect(paths.pidMap(42)).toBe('/r/state/pid-map/42.json');
    expect(paths.proxy(42)).toBe('/r/state/proxies/42.json');
    expect(paths.tokenFile('k', 'claude-api')).toBe('/r/state/tokens/k/claude-api.json');
    expect(paths.tokenLock('k', 'claude-api')).toBe('/r/state/tokens/k/claude-api.lock');
    expect(paths.tokensDir('k')).toBe('/r/state/tokens/k');
  });
});

describe('writePrivateJson / readPrivateJson', () => {
  it('creates 0700 directories and a 0600 file, atomically (no temporary file left)', () => {
    const target = join(dir, 'state', 'tokens', 'k', 'a.json');
    writePrivateJson(target, { a: 1 });

    expect(modeOf(target)).toBe(0o600);
    expect(modeOf(join(dir, 'state', 'tokens', 'k'))).toBe(0o700);
    expect(modeOf(join(dir, 'state'))).toBe(0o700);
    expect(readdirSync(join(dir, 'state', 'tokens', 'k'))).toEqual(['a.json']);
    expect(readPrivateJson(target)).toEqual({ a: 1 });
  });

  it('replaces an existing file in place', () => {
    const target = join(dir, 'a.json');
    writePrivateJson(target, { v: 1 });
    writePrivateJson(target, { v: 2 });
    expect(readPrivateJson(target)).toEqual({ v: 2 });
  });

  it('returns undefined for a missing file', () => {
    expect(readPrivateJson(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('fails with SESSION_STATE_INSECURE_PERMS on a file readable by others', () => {
    const target = join(dir, 'lax.json');
    writeFileSync(target, '{}', { mode: 0o644 });
    chmodSync(target, 0o644);

    expect(() => readPrivateJson(target)).toThrow(SessionStateError);
    try {
      readPrivateJson(target);
    } catch (err) {
      expect((err as SessionStateError).code).toBe('SESSION_STATE_INSECURE_PERMS');
    }
  });

  it('fails with SESSION_STATE_INSECURE_PERMS on a directory open to others', () => {
    const sub = join(dir, 'open');
    mkdirSync(sub, { mode: 0o755 });
    chmodSync(sub, 0o755);
    const target = join(sub, 'a.json');
    writeFileSync(target, '{}', { mode: 0o600 });

    expect(() => readPrivateJson(target)).toThrow(/chmod 700/);
  });

  it('refuses to write into an existing directory open to others', () => {
    const sub = join(dir, 'open');
    mkdirSync(sub, { mode: 0o755 });
    chmodSync(sub, 0o755);
    expect(() => writePrivateJson(join(sub, 'a.json'), {})).toThrow(SessionStateError);
  });

  it('fails with SESSION_STATE_INVALID on a file that is not JSON', () => {
    const target = join(dir, 'bad.json');
    writeFileSync(target, 'not json', { mode: 0o600 });
    let caught: unknown;
    try {
      readPrivateJson(target);
    } catch (err) {
      caught = err;
    }
    expect((caught as SessionStateError).code).toBe('SESSION_STATE_INVALID');
  });

  it('skips the permission checks on Windows', () => {
    const target = join(dir, 'lax.json');
    writeFileSync(target, '{"w":1}', { mode: 0o644 });
    chmodSync(target, 0o644);
    expect(readPrivateJson(target, 'win32')).toEqual({ w: 1 });
  });
});

describe('removePrivateFile', () => {
  it('removes a file and tolerates a missing one', () => {
    const target = join(dir, 'a.json');
    writePrivateJson(target, {});
    removePrivateFile(target);
    removePrivateFile(target);
    expect(readdirSync(dir)).toEqual([]);
  });
});
