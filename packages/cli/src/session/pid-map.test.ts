import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  processStartTime,
  publishProxyEntry,
  readLiveProxyEntry,
  readPidMapEntry,
  removeProxyEntry,
} from './pid-map.js';
import { statePaths, writePrivateJson } from './state-dir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-pidmap-'));
  chmodSync(dir, 0o700);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('processStartTime', () => {
  it('returns a stable value for a live process and undefined for a missing one', () => {
    const first = processStartTime(process.pid);
    expect(first).toBeTruthy();
    expect(processStartTime(process.pid)).toBe(first);
    expect(processStartTime(2 ** 22 + 12345)).toBeUndefined();
  });
});

describe('readPidMapEntry', () => {
  const startOf = (pid: number) => (pid === 4242 ? 'Thu Nov  6 10:00:00 2026' : undefined);

  it('returns the entry when the start time of the process matches', () => {
    const paths = statePaths(dir);
    writePrivateJson(paths.pidMap(4242), {
      claudePid: 4242,
      claudeStartTime: 'Thu Nov  6 10:00:00 2026',
      sessionId: 's-1',
      source: 'resume',
      name: 'claude-api',
    });
    expect(readPidMapEntry(paths, 4242, startOf)).toEqual({
      claudePid: 4242,
      claudeStartTime: 'Thu Nov  6 10:00:00 2026',
      sessionId: 's-1',
      source: 'resume',
      name: 'claude-api',
    });
  });

  it('ignores an entry whose start time differs (reused PID)', () => {
    const paths = statePaths(dir);
    writePrivateJson(paths.pidMap(4242), {
      claudePid: 4242,
      claudeStartTime: 'Wed Nov  5 09:00:00 2026',
      sessionId: 's-1',
      source: 'resume',
      name: 'claude-api',
    });
    expect(readPidMapEntry(paths, 4242, startOf)).toBeUndefined();
  });

  it('ignores an entry of a process that no longer exists, a missing entry and a malformed one', () => {
    const paths = statePaths(dir);
    writePrivateJson(paths.pidMap(7), {
      claudePid: 7,
      claudeStartTime: 'x',
      sessionId: 's',
      source: 'startup',
    });
    expect(readPidMapEntry(paths, 7, startOf)).toBeUndefined();
    expect(readPidMapEntry(paths, 4243, startOf)).toBeUndefined();
    writePrivateJson(paths.pidMap(4242), { claudePid: 'nope' });
    expect(readPidMapEntry(paths, 4242, startOf)).toBeUndefined();
  });
});

describe('proxies/ entries', () => {
  const entry = {
    claudePid: 4242,
    claudeStartTime: 'Thu Nov  6 10:00:00 2026',
    proxyHandle: 'h1',
    socketPath: '/r/run/h1.sock',
    registered: false,
  };

  it('publishes a 0600 entry, reads it back while the process lives, and removes it', () => {
    const paths = statePaths(dir);
    publishProxyEntry(paths, entry);
    expect(statSync(paths.proxy(4242)).mode & 0o777).toBe(0o600);
    expect(readLiveProxyEntry(paths, 4242, () => entry.claudeStartTime)).toEqual(entry);
    publishProxyEntry(paths, { ...entry, registered: true, name: 'claude-api' });
    expect(readLiveProxyEntry(paths, 4242, () => entry.claudeStartTime)).toMatchObject({
      registered: true,
      name: 'claude-api',
    });
    removeProxyEntry(paths, 4242);
    expect(existsSync(paths.proxy(4242))).toBe(false);
  });

  it('treats an entry as orphaned when the start time no longer matches', () => {
    const paths = statePaths(dir);
    publishProxyEntry(paths, entry);
    expect(readLiveProxyEntry(paths, 4242, () => 'another start')).toBeUndefined();
    expect(readLiveProxyEntry(paths, 4242, () => undefined)).toBeUndefined();
  });
});
