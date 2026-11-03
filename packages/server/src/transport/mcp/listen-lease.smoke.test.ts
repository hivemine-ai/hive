// PRY-083: a silent network cut, end to end. A TCP proxy sits between `hivectl watch`'s
// client library and the production wire. Its blackhole mode keeps every socket open but
// drops the bytes in both directions, which is what a real `DROP` rule does: the server
// keeps writing keep-alives into its kernel buffer without an error. Only the lease the
// client asked for lets the server notice and report the participant offline.

import * as net from 'node:net';

import { createRuntimeDeps, createSdkConnector, runListenLoop } from '@hive/client';
import type { LogEntry, WatchEvent } from '@hive/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '#observability/logger.js';

import { seedSmokeWorld, type SmokeWorld } from './smoke-world.js';

const PROTOCOL_VERSION = '2026-07-28';
const LEASE_MS = 600;
const BEAT_MS = LEASE_MS / 4;
/** Scheduling slack on a loaded CI runner, on top of the lease. */
const MARGIN_MS = 400;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface BlackholeProxy {
  url: string;
  /** Drop every byte in both directions; keep every socket open. */
  cut(): void;
  /** Forward again. Pairs that lost a side during the cut are torn down. */
  restore(): void;
  close(): Promise<void>;
}

async function startProxy(targetPort: number): Promise<BlackholeProxy> {
  let blackhole = false;
  const pairs = new Set<{ down: net.Socket; up: net.Socket; broken: boolean }>();

  const server = net.createServer((down) => {
    const up = net.connect(targetPort, '127.0.0.1');
    const pair = { down, up, broken: false };
    pairs.add(pair);
    const forward = (from: net.Socket, to: net.Socket): void => {
      from.on('data', (chunk) => {
        if (!blackhole && !to.destroyed) to.write(chunk);
      });
      from.on('close', () => {
        if (blackhole) pair.broken = true;
        else to.destroy();
        pairs.delete(pair);
      });
      from.on('error', () => undefined);
    };
    forward(down, up);
    forward(up, down);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const destroyAll = (): void => {
    for (const pair of pairs) {
      pair.down.destroy();
      pair.up.destroy();
    }
  };

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    cut() {
      blackhole = true;
    },
    restore() {
      blackhole = false;
      // A socket that closed during the cut never told its peer. Do it now, as TCP
      // would once the path is back.
      for (const pair of Array.from(pairs)) {
        if (pair.broken || pair.down.destroyed || pair.up.destroyed) {
          pair.down.destroy();
          pair.up.destroy();
        }
      }
    },
    async close() {
      destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectDirect(world: SmokeWorld, jwt: string, url?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url ?? `${world.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${jwt}` } },
  });
  const client = new Client(
    { name: 'hive-lease-smoke', version: '0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

async function isOnline(client: Client, participant: string): Promise<boolean> {
  const result = await client.callTool({ name: 'get_agent_status', arguments: { participant } });
  return (result.structuredContent as { presence: string }).presence === 'online';
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Best-effort close: a path that was cut may never answer. */
async function within(step: Promise<unknown>, ms = 1000): Promise<void> {
  await Promise.race([
    step.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

/** Polls presence and returns how long after `since` it first read offline. */
async function measureOffline(
  observer: Client,
  participant: string,
  since: number,
  ms: number,
): Promise<number> {
  const end = since + ms;
  while (Date.now() < end) {
    if (!(await isOnline(observer, participant))) return Date.now() - since;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`still online ${String(ms)} ms after the cut`);
}

describe('listen lease over a silent network cut (PRY-083)', () => {
  let world: SmokeWorld;
  let proxy: BlackholeProxy;
  let observer: Client;
  const logger = createLogger({ level: 'silent' });
  const cleanups: Array<() => Promise<void>> = [];

  async function start(): Promise<void> {
    world = await seedSmokeWorld({
      logger,
      credentialTtlMs: 10 * THIRTY_DAYS_MS,
      wire: { listenKeepAliveIntervalMs: 100, listenLeaseMs: LEASE_MS },
    });
    proxy = await startProxy(Number(new URL(world.baseUrl).port));
    observer = await connectDirect(world, world.jwtA);
  }

  function startWatch(): { events: WatchEvent[]; logs: LogEntry[] } {
    const events: WatchEvent[] = [];
    const logs: LogEntry[] = [];
    const controller = new AbortController();
    const connect = createSdkConnector({
      url: proxy.url,
      credential: world.jwtB,
      probeTimeoutMs: 3000,
      // Long enough that the server, not the client, is the one to notice the cut.
      silenceTimeoutMs: 3000,
    });
    const done = runListenLoop(
      {
        signal: controller.signal,
        authRetryMaxMs: 1000,
        backoff: { minMs: 20, maxMs: 200, factor: 2, jitter: 0 },
        onEvent: (event) => events.push(event),
      },
      createRuntimeDeps(connect, (entry) => logs.push(entry)),
    );
    cleanups.push(async () => {
      controller.abort();
      await done;
    });
    return { events, logs };
  }

  afterEach(async () => {
    proxy.restore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await observer.close().catch(() => undefined);
    await proxy.close();
    await world.cleanup();
  });

  it('a watch client behind a silent cut goes offline within the lease, then recovers with a replay', async () => {
    await start();
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    const { events, logs } = startWatch();
    await waitFor(() => isOnline(observer, world.workerBId), 5000);
    expect(logs).toContainEqual({ event: 'watch.connected', leaseMs: LEASE_MS });
    // Let a few renewals through first: the lease must not expire while the path is healthy.
    await new Promise((r) => setTimeout(r, LEASE_MS * 2));
    expect(await isOnline(observer, world.workerBId)).toBe(true);

    const cutAt = Date.now();
    proxy.cut();
    const detectionMs = await measureOffline(observer, world.workerBId, cutAt, LEASE_MS * 5);

    // The last renewal reached the server about one beat before the cut at most; two
    // beats of slack absorb a late timer without letting an immediate close pass.
    expect(detectionMs).toBeGreaterThanOrEqual(LEASE_MS - 2 * BEAT_MS);
    expect(detectionMs).toBeLessThanOrEqual(LEASE_MS + MARGIN_MS);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_listen_lease_expired',
        participantId: world.workerBId,
        leaseMs: LEASE_MS,
      }),
      expect.any(String),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'lease_expired' }),
      expect.any(String),
    );
    console.info(`[PRY-083] silent cut detected by the server after ${String(detectionMs)} ms`);

    // A message sent while the agent is offline is stored and recovered on reconnection.
    await observer.callTool({
      name: 'send_message',
      arguments: { recipient: world.workerBId, type: 'request', body: 'during the cut' },
    });
    proxy.restore();
    await waitFor(() => events.length >= 1, 10_000);
    expect(events[0]).toMatchObject({ count: 1, senders: [world.workerAId] });
    await waitFor(() => isOnline(observer, world.workerBId), 5000);
  }, 30_000);

  it('control: a client that asked for no lease stays online through the same cut', async () => {
    await start();
    const legacy = await connectDirect(world, world.jwtB, proxy.url);
    const mailboxUri = (await legacy.listResources()).resources[0]?.uri;
    if (mailboxUri === undefined) throw new Error('caller has no mailbox resource');
    const subscription = await legacy.listen({ resourceSubscriptions: [mailboxUri] });
    cleanups.push(async () => {
      proxy.restore();
      await within(subscription.close());
      await within(legacy.close());
    });
    await waitFor(() => isOnline(observer, world.workerBId), 5000);

    proxy.cut();
    await new Promise((r) => setTimeout(r, LEASE_MS * 3));

    expect(await isOnline(observer, world.workerBId)).toBe(true);
  }, 30_000);
});
