import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startFakeHiveServer } from './fake-hive-server.js';
import type { FakeHiveServer } from './fake-hive-server.js';

import { checkUnread } from './check-unread.js';
import type { WatchEvent } from './event.js';
import { runListenLoop } from './listen-loop.js';
import type { LogEntry } from './listen-loop.js';
import { createRuntimeDeps } from './runtime-deps.js';
import { createSdkConnector } from './sdk-connector.js';

const TOKEN = 'secret-token-123';
const PARTICIPANT = 'agent-1';

let server: FakeHiveServer;
let controller: AbortController;
let logs: LogEntry[];

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function startLoop(
  overrides: {
    silenceTimeoutMs?: number;
    authRetryMaxMs?: number;
    url?: string;
    token?: string;
  } = {},
): { events: WatchEvent[]; done: Promise<void> } {
  const events: WatchEvent[] = [];
  const connect = createSdkConnector({
    url: overrides.url ?? server.url,
    credential: overrides.token ?? TOKEN,
    probeTimeoutMs: 3000,
    silenceTimeoutMs: overrides.silenceTimeoutMs ?? 45_000,
  });
  const done = runListenLoop(
    {
      signal: controller.signal,
      authRetryMaxMs: overrides.authRetryMaxMs ?? 1000,
      backoff: { minMs: 20, maxMs: 100, factor: 2, jitter: 0 },
      onEvent: (e) => events.push(e),
    },
    createRuntimeDeps(connect, (l) => logs.push(l)),
  );
  return { events, done };
}

beforeEach(async () => {
  server = await startFakeHiveServer({ tokens: { [TOKEN]: PARTICIPANT }, replayOnListen: true });
  controller = new AbortController();
  logs = [];
});

afterEach(async () => {
  controller.abort();
  await server.close();
});

describe('listen over the 2.x SDK', () => {
  it('delivers a pushed event as metadata only and marks the participant online', async () => {
    const { events, done } = startLoop();
    await waitFor(() => server.online().includes(PARTICIPANT));
    server.publish(PARTICIPANT, { eventId: 'evt-1', senders: ['s1', 's2'], count: 2 });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ eventId: 'evt-1', senders: ['s1', 's2'], count: 2 });
    controller.abort();
    await done;
    await waitFor(() => server.online().length === 0);
  });

  it('calls no tool on connect and never calls read_mailbox', async () => {
    server.setUnread(PARTICIPANT, { count: 1, senders: ['s1'] });
    const { events, done } = startLoop();
    await waitFor(() => events.length === 1);
    expect(server.methods).not.toContain('tools/call');
    expect(server.toolCalls).toEqual([]);
    controller.abort();
    await done;
  });

  it('turns a server replay into the same event as an online push', async () => {
    server.setUnread(PARTICIPANT, { count: 2, senders: ['s1'] });
    const { events, done } = startLoop();
    await waitFor(() => events.length === 1);
    server.publish(PARTICIPANT, { eventId: 'evt-live', senders: ['s1'], count: 2 });
    await waitFor(() => events.length === 2);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(Object.keys(events[1] ?? {}).sort());
    expect(events[0]).toMatchObject({ senders: ['s1'], count: 2 });
    controller.abort();
    await done;
  });

  it('reconnects after a network cut and recovers through the replay, calling no tool', async () => {
    server.setUnread(PARTICIPANT, { count: 1, senders: ['s1'] });
    const { events, done } = startLoop();
    await waitFor(() => events.length === 1);
    server.dropStreams();
    await waitFor(() => server.listenCount() === 2);
    await waitFor(() => events.length === 2);
    expect(server.toolCalls).toEqual([]);
    controller.abort();
    await done;
  });

  it('forces a reconnection when keep-alives stop arriving', async () => {
    await server.close();
    server = await startFakeHiveServer({
      tokens: { [TOKEN]: PARTICIPANT },
      keepAliveMs: 100,
    });
    const { done } = startLoop({ silenceTimeoutMs: 600 });
    await waitFor(() => server.listenCount() === 1);
    server.stallStreams();
    await waitFor(() => server.listenCount() >= 2, 8000);
    expect(logs.some((l) => l.event === 'watch.disconnected' && l.reason === 'silence')).toBe(true);
    controller.abort();
    await done;
  });

  it('does not terminate while the server is down', async () => {
    const { done } = startLoop();
    await waitFor(() => server.listenCount() === 1);
    await server.close();
    let finished = false;
    void done.then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 600));
    expect(finished).toBe(false);
    controller.abort();
    await done;
    server = await startFakeHiveServer({ tokens: {} });
  });

  it('discards an event with an invalid shape', async () => {
    const { events, done } = startLoop();
    await waitFor(() => server.online().includes(PARTICIPANT));
    server.publish(PARTICIPANT, { eventId: 'bad', senders: ['s'], count: 0 });
    server.publish(PARTICIPANT, { eventId: 'good', senders: ['s'], count: 1 });
    await waitFor(() => events.length === 1);
    expect(events[0]?.eventId).toBe('good');
    expect(logs.some((l) => l.event === 'watch.discarded')).toBe(true);
    controller.abort();
    await done;
  });

  it('retries a continuous auth rejection and then gives up', async () => {
    server.setRejectAuth(true);
    const { done } = startLoop({ authRetryMaxMs: 400 });
    await expect(done).rejects.toMatchObject({ kind: 'auth_rejected' });
  });

  it('resumes inside the window when the participant is reinstated', async () => {
    server.setRejectAuth(true);
    const { events, done } = startLoop({ authRetryMaxMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    server.setRejectAuth(false);
    await waitFor(() => server.online().includes(PARTICIPANT));
    server.publish(PARTICIPANT, { eventId: 'after', senders: ['s'], count: 1 });
    await waitFor(() => events.length === 1);
    controller.abort();
    await done;
  });

  it('stops at once on an unsupported protocol revision', async () => {
    server.setUnsupportedProtocol(true);
    const { done } = startLoop();
    await expect(done).rejects.toMatchObject({ kind: 'protocol_unsupported' });
  });

  it('never leaks the credential into diagnostics', async () => {
    server.setRejectAuth(true);
    const { done } = startLoop({ authRetryMaxMs: 200 });
    await expect(done).rejects.toBeDefined();
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});

describe('closing over a silent network', () => {
  it('does not let a swallowed cancel hold up the reconnection', async () => {
    let blackhole = false;
    const connect = createSdkConnector({
      url: server.url,
      credential: TOKEN,
      probeTimeoutMs: 3000,
      silenceTimeoutMs: 45_000,
      fetch: (input, init) =>
        blackhole ? new Promise<Response>(() => undefined) : fetch(input, init),
    });
    const connection = await connect(
      { onEvent: () => undefined, onDiscard: () => undefined },
      controller.signal,
    );
    blackhole = true;
    const started = Date.now();
    await connection.close();
    expect(Date.now() - started).toBeLessThan(2500);
  }, 15_000);
});

describe('checkUnread over the 2.x SDK', () => {
  const opts = () => ({ url: server.url, credential: TOKEN, probeTimeoutMs: 3000 });

  it('makes one tool call and returns the summary', async () => {
    server.setUnread(PARTICIPANT, { count: 3, senders: ['s1', 's2'] });
    const summary = await checkUnread(opts());
    expect(summary).toEqual({ count: 3, senders: ['s1', 's2'] });
    expect(server.toolCalls.filter((c) => c === 'check_unread_messages')).toHaveLength(1);
    expect(server.toolCalls).not.toContain('read_mailbox');
    expect(server.online()).toEqual([]);
  });

  it('returns a zero summary', async () => {
    expect(await checkUnread(opts())).toEqual({ count: 0, senders: [] });
  });

  it('reports a rejected credential', async () => {
    server.setRejectAuth(true);
    await expect(checkUnread(opts())).rejects.toMatchObject({ kind: 'auth_rejected' });
  });

  it('reports a tool failure as a transport error', async () => {
    server.setCheckFails(true);
    await expect(checkUnread(opts())).rejects.toMatchObject({ kind: 'transport' });
  });
});
