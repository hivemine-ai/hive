import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type HiveStatusSnapshot,
  atomicWriteJson,
  isStale,
  snapshotPath,
} from './status-snapshot.js';

function buildSnapshot(overrides: Partial<HiveStatusSnapshot> = {}): HiveStatusSnapshot {
  return {
    v: 1,
    writtenAt: '2026-05-03T12:00:00.000Z',
    heartbeatSeconds: 30,
    hive: { name: 'test-hive', colonies: 1, keepers: 1, agents: 0 },
    server: null,
    database: { driver: 'sqlite', location: './var/db/hive.sqlite' },
    lastAudit: null,
    ...overrides,
  };
}

describe('snapshotPath', () => {
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env['XDG_STATE_HOME'];
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_STATE_HOME'];
    } else {
      process.env['XDG_STATE_HOME'] = originalXdg;
    }
  });

  test('honours XDG_STATE_HOME when set', () => {
    process.env['XDG_STATE_HOME'] = '/custom/state';
    expect(snapshotPath()).toBe('/custom/state/hive/status.json');
  });

  test('falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
    delete process.env['XDG_STATE_HOME'];
    expect(snapshotPath()).toBe(join(homedir(), '.local', 'state', 'hive', 'status.json'));
  });

  test('treats empty XDG_STATE_HOME as unset', () => {
    process.env['XDG_STATE_HOME'] = '';
    expect(snapshotPath()).toBe(join(homedir(), '.local', 'state', 'hive', 'status.json'));
  });
});

describe('isStale', () => {
  test('exactly at boundary (2 × heartbeatSeconds elapsed) is fresh', () => {
    const writtenAtMs = Date.parse('2026-05-03T12:00:00.000Z');
    const nowMs = writtenAtMs + 30 * 2 * 1000;
    expect(isStale(buildSnapshot({ heartbeatSeconds: 30 }), nowMs)).toBe(false);
  });

  test('1ms past the boundary is stale', () => {
    const writtenAtMs = Date.parse('2026-05-03T12:00:00.000Z');
    const nowMs = writtenAtMs + 30 * 2 * 1000 + 1;
    expect(isStale(buildSnapshot({ heartbeatSeconds: 30 }), nowMs)).toBe(true);
  });

  test('writtenAt in the future (negative skew) is treated as fresh', () => {
    const writtenAtMs = Date.parse('2026-05-03T12:00:00.000Z');
    const nowMs = writtenAtMs - 60 * 1000;
    expect(isStale(buildSnapshot(), nowMs)).toBe(false);
  });

  test('malformed writtenAt is stale', () => {
    expect(isStale(buildSnapshot({ writtenAt: 'not-a-date' }))).toBe(true);
  });

  test('uses Date.now() when now is omitted', () => {
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(buildSnapshot({ writtenAt: longAgo, heartbeatSeconds: 30 }))).toBe(true);
  });
});

describe('atomicWriteJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'snap-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes the file with the serialised payload', () => {
    const path = join(tmpDir, 'snap.json');
    const payload = { hello: 'world', n: 42 };
    atomicWriteJson(path, payload);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(payload);
  });

  test('removes the .tmp file after successful rename', () => {
    const path = join(tmpDir, 'snap.json');
    atomicWriteJson(path, { ok: true });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test('creates parent directories if missing', () => {
    const path = join(tmpDir, 'nested', 'sub', 'snap.json');
    atomicWriteJson(path, { ok: true });
    expect(existsSync(path)).toBe(true);
  });

  test('overwrites an existing file atomically', () => {
    const path = join(tmpDir, 'snap.json');
    atomicWriteJson(path, { v: 'first' });
    atomicWriteJson(path, { v: 'second' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 'second' });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
