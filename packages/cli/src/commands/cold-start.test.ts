import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as HttpModule from 'node:http';
import type * as HttpsModule from 'node:https';
import type * as NetModule from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runColdStart } from './cold-start.js';

// `vi.mock` rewrites the `node:net` module BEFORE the import graph
// resolves, so any direct or transitive `from 'node:net'` inside
// runColdStart's chain gets the mock here. The mocked surface is
// `connect` and `createConnection` — the entry points for opening
// outbound TCP sockets. The `Socket` class is intentionally NOT
// mocked: callers that do `new Socket().connect(...)` route through
// `net.connect` internally, which IS mocked above, so the throw
// still fires. If a future caller bypassed `net.connect` by other
// means (e.g. raw libuv handles), this guard would not catch it —
// at that point widen the mocks here. Each mock throws with a
// pointed message so a regression names the offender immediately.
//
// Static analysis already says runColdStart imports renderColdStart
// (pure) + readSnapshot (fs only), but this dynamic guard catches
// future regressions (a new transitive dep pulling something
// network-touching) without rerunning the manual `strace` /  `lsof`
// AC smokes on every commit.
vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof NetModule>('node:net');
  return {
    ...actual,
    connect: vi.fn(() => {
      throw new Error('zero-network violated: node:net.connect was called');
    }),
    createConnection: vi.fn(() => {
      throw new Error('zero-network violated: node:net.createConnection was called');
    }),
  };
});

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof HttpModule>('node:http');
  return {
    ...actual,
    request: vi.fn(() => {
      throw new Error('zero-network violated: node:http.request was called');
    }),
    get: vi.fn(() => {
      throw new Error('zero-network violated: node:http.get was called');
    }),
  };
});

vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof HttpsModule>('node:https');
  return {
    ...actual,
    request: vi.fn(() => {
      throw new Error('zero-network violated: node:https.request was called');
    }),
    get: vi.fn(() => {
      throw new Error('zero-network violated: node:https.get was called');
    }),
  };
});

interface FixtureOpts {
  hiveName?: string;
  serverNull?: boolean;
  ageMs?: number;
}

async function writeSnapshot(xdgDir: string, opts: FixtureOpts = {}): Promise<void> {
  const ageMs = opts.ageMs ?? 0;
  const writtenAt = new Date(Date.now() - ageMs).toISOString();
  const snap = {
    v: 1,
    writtenAt,
    heartbeatSeconds: 60,
    hive: { name: opts.hiveName ?? 'test-hive', colonies: 1, keepers: 1, agents: 1 },
    server: opts.serverNull
      ? null
      : {
          bind: '127.0.0.1:7700',
          pid: 99999,
          uptimeStartedAt: writtenAt,
          version: '0.1.0',
        },
    database: { driver: 'sqlite', location: './var/db/hive.sqlite', sizeBytes: 1024 },
    lastAudit: { at: writtenAt, event: 'init.completed', actor: 'admin@test-hive' },
  };
  const dir = join(xdgDir, 'hive');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify(snap));
}

describe('runColdStart', () => {
  let xdgDir: string;
  let stdoutWrites: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    xdgDir = await mkdtemp(join(tmpdir(), 'hivectl-coldstart-'));
    process.env['XDG_STATE_HOME'] = xdgDir;
    stdoutWrites = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    delete process.env['XDG_STATE_HOME'];
    await rm(xdgDir, { recursive: true, force: true });
  });

  it('renders the missing-snapshot frame on a fresh install (no snapshot file)', async () => {
    await runColdStart();
    const out = stdoutWrites.join('');
    expect(out).toContain('no snapshot yet');
    expect(out).toContain('no hive initialised on this machine.');
    expect(out).toContain('hivectl init');
  });

  it('renders the fresh frame when a recent snapshot exists', async () => {
    await writeSnapshot(xdgDir);
    await runColdStart();
    const out = stdoutWrites.join('');
    expect(out).toContain('test-hive');
    expect(out).toContain('running');
    expect(out).toContain('init.completed');
    expect(out).toContain('try');
  });

  it('renders the stale frame when the snapshot is older than 2× heartbeat', async () => {
    // heartbeat=60s, stale boundary is 120s, set age to 252s.
    await writeSnapshot(xdgDir, { ageMs: 252_000 });
    await runColdStart();
    const out = stdoutWrites.join('');
    expect(out).toContain('snapshot 4m 12s ago — stale');
    expect(out).toContain('verify');
  });

  it('opens ZERO TCP/HTTP sockets during cold start with no snapshot (AC: zero-network)', async () => {
    // The vi.mock guards above throw on any net/http call. If runColdStart
    // attempted any network I/O this resolves rejected. No assertion on
    // the mocks themselves needed — `await` either completes or throws.
    await expect(runColdStart()).resolves.toBeUndefined();
  });

  it('opens ZERO TCP/HTTP sockets during cold start with a valid snapshot', async () => {
    await writeSnapshot(xdgDir);
    await expect(runColdStart()).resolves.toBeUndefined();
  });

  it('opens ZERO TCP/HTTP sockets during cold start with a stale snapshot', async () => {
    await writeSnapshot(xdgDir, { ageMs: 252_000 });
    await expect(runColdStart()).resolves.toBeUndefined();
  });
});
