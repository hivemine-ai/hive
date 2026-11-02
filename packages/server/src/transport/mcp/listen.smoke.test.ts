// Push over `subscriptions/listen` against the production wire: real SQLite, real
// credentials, the real SDK 2.x client and the real HTTP stack.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { CallerContext } from '#domain/auth/index.js';
import { createDb } from '#persistence/db.js';

import { seedSmokeWorld, type SmokeWorld } from './smoke-world.js';

const PROTOCOL_VERSION = '2026-07-28';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SYSTEM_CALLER: CallerContext = { kind: 'system', osUser: 'listen-smoke' };

interface Waggle {
  kind: string;
  unread_count: number;
  sender_ids: string[];
  event_id: string;
  [key: string]: unknown;
}

interface Listener {
  client: Client;
  waggles: Waggle[];
  close: () => Promise<void>;
  closed: Promise<unknown>;
  mailboxUri: string;
}

async function connect(world: SmokeWorld, jwt: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${world.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${jwt}` } },
  });
  const client = new Client(
    { name: 'hive-listen-smoke', version: '0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

async function listen(world: SmokeWorld, jwt: string): Promise<Listener> {
  const client = await connect(world, jwt);
  const waggles: Waggle[] = [];
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    const meta = notification.params._meta as { hiveWaggle?: Waggle } | undefined;
    if (meta?.hiveWaggle) waggles.push(meta.hiveWaggle);
  });
  const mailboxUri = (await client.listResources()).resources[0]?.uri;
  if (mailboxUri === undefined) throw new Error('caller has no mailbox resource');
  const subscription = await client.listen({ resourceSubscriptions: [mailboxUri] });
  return {
    client,
    waggles,
    mailboxUri,
    closed: subscription.closed,
    close: async () => {
      await subscription.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

async function send(client: Client, recipient: string, body = 'ping'): Promise<string> {
  const result = await client.callTool({
    name: 'send_message',
    arguments: { recipient, type: 'request', body },
  });
  expect(result.isError ?? false).toBe(false);
  return (result.structuredContent as { message_id: string }).message_id;
}

async function markAllRead(client: Client): Promise<void> {
  const mailbox = await client.callTool({ name: 'read_mailbox', arguments: {} });
  const ids = (mailbox.structuredContent as { messages: { id: string }[] }).messages.map(
    (m) => m.id,
  );
  await client.callTool({ name: 'mark_read', arguments: { message_ids: ids } });
}

async function rawListen(
  world: SmokeWorld,
  jwt: string,
  notifications: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${world.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${jwt}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: {
        notifications,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

/** Writes the state the way `hivectl` does: from outside the server process. */
async function setAgentState(world: SmokeWorld, state: 'active' | 'suspended'): Promise<void> {
  const db = createDb({ dialect: 'sqlite', url: world.dbUrl, sqliteWal: false });
  await db.updateTable('agents').set({ state }).where('id', '=', world.workerBId).execute();
  await db.destroy();
}

const QUICK = { timeout: 3000, interval: 20 };

function expectOnline(client: Client, participant: string, online: boolean): Promise<void> {
  return vi.waitFor(async () => {
    expect(await isOnline(client, participant)).toBe(online);
  }, QUICK);
}

function expectWaggles(listener: Listener, count: number): Promise<void> {
  return vi.waitFor(() => {
    expect(listener.waggles.length).toBeGreaterThanOrEqual(count);
  }, QUICK);
}

async function isOnline(client: Client, participant: string): Promise<boolean> {
  const result = await client.callTool({
    name: 'get_agent_status',
    arguments: { participant },
  });
  return (result.structuredContent as { presence: string }).presence === 'online';
}

describe('listen push over the real stack', () => {
  let world: SmokeWorld;
  let sender: Client;
  const listeners: Listener[] = [];

  async function open(jwt: string): Promise<Listener> {
    const listener = await listen(world, jwt);
    listeners.push(listener);
    return listener;
  }

  async function start(options: Parameters<typeof seedSmokeWorld>[0] = {}): Promise<void> {
    world = await seedSmokeWorld({
      credentialTtlMs: 10 * THIRTY_DAYS_MS,
      ...options,
      wire: { listenKeepAliveIntervalMs: 100, ...options.wire },
    });
    sender = await connect(world, world.jwtA);
  }

  beforeEach(() => {
    process.env['HIVE_WAGGLE_QUIET_WINDOW_MS'] = '10';
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['HIVE_WAGGLE_QUIET_WINDOW_MS'];
    delete process.env['HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW'];
    delete process.env['HIVE_WAGGLE_SENDER_WINDOW_MS'];
    for (const listener of listeners.splice(0)) await listener.close();
    await sender.close().catch(() => undefined);
    await world.cleanup();
  });

  it('reproduces INC-2026-007: a stream with no traffic still receives a push after any lapse', async () => {
    await start();
    const listener = await open(world.jwtB);
    await expectOnline(sender, world.workerBId, true);

    // The old idle sweep measured wall-clock silence; move the clock past any threshold.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + THIRTY_DAYS_MS);

    expect(await isOnline(sender, world.workerBId)).toBe(true);
    await send(sender, world.workerBId);

    await expectWaggles(listener, 1);
    expect(listener.waggles[0]).toMatchObject({
      kind: 'online',
      unread_count: 1,
      sender_ids: [world.workerAId],
    });
  });

  it('Envelope 1 carries exactly the wire fields, nothing about the message', async () => {
    await start();
    const listener = await open(world.jwtB);
    await expectOnline(sender, world.workerBId, true);

    await send(sender, world.workerBId, 'top secret body');

    await expectWaggles(listener, 1);
    const waggle = listener.waggles[0];
    expect(Object.keys(waggle ?? {}).sort()).toEqual([
      'emitted_at',
      'event_id',
      'kind',
      'recipient_id',
      'sender_ids',
      'unread_count',
      'waggle_id',
    ]);
    expect(waggle?.recipient_id).toBe(world.workerBId);
    expect(JSON.stringify(waggle)).not.toContain('top secret');
  });

  it('a Hivekeeper has a Cell: it listens to its own mailbox like an agent', async () => {
    await start();
    const listener = await open(world.jwtAdmin);
    const keeper = await connect(world, world.jwtAdmin);
    await expectOnline(keeper, world.adminId, true);

    await send(keeper, world.adminId);
    await keeper.close();

    await expectWaggles(listener, 1);
    expect(listener.waggles[0]?.recipient_id).toBe(world.adminId);
  });

  describe('authorization', () => {
    it('a foreign URI gets -32602, no stream, no presence, no events', async () => {
      await start();
      const victim = await open(world.jwtB);
      const victimUri = victim.mailboxUri;

      const res = await rawListen(world, world.jwtA, { resourceSubscriptions: [victimUri] });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
      const observer = await connect(world, world.jwtB);
      expect(await isOnline(observer, world.workerAId)).toBe(false);
      await observer.close();
    });

    it('an empty resourceSubscriptions is served and never counts as presence', async () => {
      await start();
      const res = await rawListen(world, world.jwtB, { resourceSubscriptions: [] });

      expect(res.headers.get('content-type')).toContain('text/event-stream');
      await res.text();
      expect(await isOnline(sender, world.workerBId)).toBe(false);
    });

    it('a stream of toolsListChanged only never counts as presence', async () => {
      await start();
      const res = await rawListen(world, world.jwtB, { toolsListChanged: true });

      expect(res.headers.get('content-type')).toContain('text/event-stream');
      await res.text();
      expect(await isOnline(sender, world.workerBId)).toBe(false);
    });

    it('a client that only POSTs takes no presence', async () => {
      await start();
      await send(sender, world.workerBId);
      const observer = await connect(world, world.jwtB);
      expect(await isOnline(observer, world.workerAId)).toBe(false);
      await observer.close();
    });
  });

  describe('presence follows the stream', () => {
    it('drops within 5 s when the client goes away', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      const startedAt = Date.now();
      await listener.close();

      await expectOnline(sender, world.workerBId, false);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });
  });

  describe('replay', () => {
    it('a message stored offline arrives after the acknowledgment, on every reconnection', async () => {
      await start();
      await send(sender, world.workerBId);

      const first = await open(world.jwtB);
      await expectWaggles(first, 1);
      expect(first.waggles[0]).toMatchObject({ kind: 'replay', unread_count: 1 });
      await first.close();

      const second = await open(world.jwtB);
      await expectWaggles(second, 1);
      await second.close();

      const third = await open(world.jwtB);
      await expectWaggles(third, 1);
      expect(third.waggles[0]?.event_id).toBe(first.waggles[0]?.event_id);
    });

    it('nothing unread means no replay at all', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listener.waggles).toHaveLength(0);
    });

    it('a replay reaches only the new stream, not its sisters', async () => {
      await start();
      const existing = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);
      await send(sender, world.workerBId);
      await expectWaggles(existing, 1);

      const added = await open(world.jwtB);
      await expectWaggles(added, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(added.waggles[0]?.kind).toBe('replay');
      expect(existing.waggles).toHaveLength(1);
    });

    it('an online and a replay event of the same state share the event id', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);
      await send(sender, world.workerBId);
      await expectWaggles(listener, 1);
      await listener.close();

      const again = await open(world.jwtB);
      await expectWaggles(again, 1);

      expect(listener.waggles[0]?.kind).toBe('online');
      expect(again.waggles[0]?.kind).toBe('replay');
      expect(again.waggles[0]?.event_id).toBe(listener.waggles[0]?.event_id);
    });

    it('a resumed agent that kept its stream gets a replay', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);
      // Suspended and resumed behind the signal: the stream survives, as with a blip
      // between two re-verification passes.
      const writeRepo = world.wire._participantsWriteRepo();
      await setAgentState(world, 'suspended');
      await send(sender, world.workerBId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(listener.waggles).toHaveLength(0);

      await writeRepo.resumeAgent(world.workerBId, SYSTEM_CALLER);

      await expectWaggles(listener, 1);
      expect(listener.waggles[0]).toMatchObject({ kind: 'replay', unread_count: 1 });
    });
  });

  describe('close', () => {
    it('suspending cuts the stream and later messages produce nothing', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      await world.wire._participantsWriteRepo().suspendAgent(world.workerBId, SYSTEM_CALLER);

      await listener.closed;
      expect(await isOnline(sender, world.workerBId)).toBe(false);
      await send(sender, world.workerBId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(listener.waggles).toHaveLength(0);
    });

    it('revoking the agent cuts the stream', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      await world.wire._participantsWriteRepo().revokeAgent(world.workerBId, SYSTEM_CALLER);

      await listener.closed;
    });

    it('a change made by another process is caught by the re-verification pass', async () => {
      await start({ wire: { reverifyIntervalSeconds: 1 } });
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      await setAgentState(world, 'suspended');

      await listener.closed;
      await expectOnline(sender, world.workerBId, false);
    }, 10_000);

    it('an expired JWT cuts the stream', async () => {
      await start({ credentialTtlMs: 1500 });
      const listener = await open(world.jwtB);

      await listener.closed;
    }, 10_000);

    it('the stream evicted at the cap ends with complete; the new one is served', async () => {
      process.env['HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT'] = '1';
      try {
        await start();
        const oldest = await open(world.jwtB);
        await expectOnline(sender, world.workerBId, true);

        const newest = await open(world.jwtB);

        await expect(oldest.closed).resolves.toBeDefined();
        await send(sender, world.workerBId);
        await expectWaggles(newest, 1);
      } finally {
        delete process.env['HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT'];
      }
    });

    it('shutdown ends the stream with complete and does not hang the drain', async () => {
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      const startedAt = Date.now();
      await world.wire.stop();

      await expect(listener.closed).resolves.toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });
  });

  describe('limits', () => {
    it('a burst of one sender produces a bounded number of events and loses nothing', async () => {
      process.env['HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW'] = '2';
      process.env['HIVE_WAGGLE_SENDER_WINDOW_MS'] = '500';
      await start();
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);

      for (let i = 0; i < 20; i += 1) await send(sender, world.workerBId, `burst-${String(i)}`);

      await vi.waitFor(() => {
        expect(listener.waggles.at(-1)?.unread_count).toBe(20);
      }, QUICK);
      expect(listener.waggles.length).toBeLessThanOrEqual(6);
      const reader = await connect(world, world.jwtB);
      const unread = await reader.callTool({ name: 'check_unread_messages', arguments: {} });
      expect((unread.structuredContent as { unread_count: number }).unread_count).toBe(20);
      await reader.close();
    });

    it('a sender over the quota is refused, stores nothing and wakes nobody', async () => {
      await start({ wire: { maxUnreadPerSender: 1 } });
      const listener = await open(world.jwtB);
      await expectOnline(sender, world.workerBId, true);
      await send(sender, world.workerBId);
      await expectWaggles(listener, 1);

      await expect(
        sender.callTool({
          name: 'send_message',
          arguments: { recipient: world.workerBId, type: 'request', body: 'over' },
        }),
      ).rejects.toMatchObject({ code: -32005, data: { limit: 1, current: 1 } });

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(listener.waggles).toHaveLength(1);

      const reader = await connect(world, world.jwtB);
      await markAllRead(reader);
      await reader.close();
      await expect(send(sender, world.workerBId)).resolves.toEqual(expect.any(String));
    });
  });
});
