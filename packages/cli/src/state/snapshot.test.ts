import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HiveStatusSnapshot } from '@hive/shared';

import { readSnapshot } from './snapshot.js';

function buildValidSnapshot(): HiveStatusSnapshot {
  return {
    v: 1,
    writtenAt: '2026-05-03T12:00:00.000Z',
    heartbeatSeconds: 30,
    hive: { name: 'test-hive', colonies: 1, keepers: 1, agents: 0 },
    server: {
      bind: '127.0.0.1:8443',
      pid: 100,
      uptimeStartedAt: '2026-05-03T11:00:00.000Z',
      version: '0.1.0-dev',
    },
    database: { driver: 'sqlite', location: 'sqlite:./var/db/hive.sqlite' },
    lastAudit: null,
  };
}

describe('readSnapshot', () => {
  let tmpDir: string;
  let snapshotFile: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'snap-reader-test-'));
    snapshotFile = join(tmpDir, 'status.json');
    warn = vi.fn();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null silently when the snapshot file is missing (ENOENT)', async () => {
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null + warn when the file contains malformed JSON', async () => {
    writeFileSync(snapshotFile, '{ not valid json', 'utf8');
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/not valid JSON/);
  });

  it('returns null + warn when the schema version is unknown (v != 1)', async () => {
    writeFileSync(snapshotFile, JSON.stringify({ v: 99, writtenAt: 'x' }), 'utf8');
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/unsupported schema version/);
    expect(line).toMatch(/v=99/);
  });

  it('returns null + warn when version is missing entirely', async () => {
    writeFileSync(snapshotFile, JSON.stringify({ writtenAt: 'x' }), 'utf8');
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/v=<missing>/);
  });

  it('returns the well-typed object for a valid v:1 snapshot', async () => {
    const valid = buildValidSnapshot();
    writeFileSync(snapshotFile, JSON.stringify(valid), 'utf8');
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toEqual(valid);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null + warn when expected fields are missing despite v=1', async () => {
    writeFileSync(snapshotFile, JSON.stringify({ v: 1, writtenAt: '2026-05-03' }), 'utf8');
    const result = await readSnapshot({
      pathResolver: () => snapshotFile,
      warn,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
