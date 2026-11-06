import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { IdentityContext, Verifier } from '#domain/auth/index.js';
import type { Cell } from '#domain/cells/index.js';
import { WaggleError } from '#domain/notifications/index.js';
import type { PresenceRegistry, Subscription } from '#domain/notifications/index.js';
import type { Logger } from '#observability/logger.js';

import { createListenStreams, type ListenStreamsDeps } from './listen-stream.js';

const OWN_CELL = '01900000-0000-7000-8000-00000000000c';
const OWN_URI = `hive://cells/${OWN_CELL}`;
const FOREIGN_URI = 'hive://cells/01900000-0000-7000-8000-0000000000ff';

const IDENTITY = {
  participantId: '01900000-0000-7000-8000-00000000000b',
  snapshot: { credentialJti: '01900000-0000-7000-8000-0000000000aa' },
} as unknown as IdentityContext;

class FakeRaw extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  socket = { setKeepAlive: vi.fn() };
  headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  write(_chunk: string, callback: () => void): boolean {
    callback();
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function logs() {
  const entries: Array<Record<string, unknown>> = [];
  const push = (payload: Record<string, unknown>): void => {
    entries.push(payload);
  };
  return {
    entries,
    logger: { info: push, warn: push, error: push, debug: push } as unknown as Logger,
  };
}

function listenBody(uris: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id: 3,
    method: 'subscriptions/listen',
    params: { notifications: { resourceSubscriptions: uris } },
  };
}

function sseResponse(): Response {
  return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeSubscription(): Subscription & { ready: ReturnType<typeof vi.fn> } {
  return { ready: vi.fn() } as unknown as Subscription & { ready: ReturnType<typeof vi.fn> };
}

function build(overrides: Partial<ListenStreamsDeps> = {}) {
  const log = logs();
  const subscribe = vi.fn(() => Promise.resolve(fakeSubscription()));
  const streams = createListenStreams({
    cellsRepo: {
      findCellByOwner: () => Promise.resolve({ id: OWN_CELL } as Cell),
    },
    presenceRegistry: { subscribe },
    verifier: { reverifyStream: () => Promise.resolve({ ok: true }) },
    serverInfo: { name: 'hive', version: '1' },
    logger: log.logger,
    keepAliveIntervalMs: 60_000,
    stallTimeoutMs: 30_000,
    reverifyIntervalSeconds: 0,
    leaseMs: 60_000,
    ...overrides,
  });
  return { streams, subscribe, log };
}

function open(
  streams: ReturnType<typeof build>['streams'],
  uris: unknown = [OWN_URI],
  options: { leaseKey?: string; identity?: IdentityContext } = {},
) {
  const raw = new FakeRaw();
  const binding = streams.onResponse({
    body: listenBody(uris),
    identity: options.identity ?? IDENTITY,
    ...(options.leaseKey !== undefined && { leaseKey: options.leaseKey }),
    requestId: '01900000-0000-7000-8000-0000000000bb',
    response: sseResponse(),
    raw: raw as unknown as ServerResponse,
    abort: vi.fn(),
  });
  return { raw, binding };
}

describe('authorize', () => {
  const authorize = (streams: ReturnType<typeof build>['streams'], uris: unknown) =>
    streams.authorize({ body: listenBody(uris), identity: IDENTITY });

  it('accepts the own mailbox and an empty list', async () => {
    const { streams } = build();
    await expect(authorize(streams, [OWN_URI])).resolves.toBeNull();
    await expect(authorize(streams, [])).resolves.toBeNull();
  });

  it('rejects a foreign URI with -32602 and logs no URI', async () => {
    const { streams, log } = build();
    await expect(authorize(streams, [FOREIGN_URI])).resolves.toEqual({
      code: -32602,
      message: 'invalid input',
    });
    expect(log.entries).toEqual([
      expect.objectContaining({ event: 'mcp_listen_rejected', reason: 'foreign_uri' }),
    ]);
    expect(JSON.stringify(log.entries)).not.toContain(FOREIGN_URI);
  });

  it('a foreign URI next to the own one is still refused', async () => {
    const { streams } = build();
    await expect(authorize(streams, [OWN_URI, FOREIGN_URI])).resolves.toMatchObject({
      code: -32602,
    });
  });

  it('refuses a malformed list, which the filter could otherwise read differently', async () => {
    const { streams, log } = build();
    await expect(authorize(streams, FOREIGN_URI)).resolves.toMatchObject({ code: -32602 });
    await expect(authorize(streams, [1])).resolves.toMatchObject({ code: -32602 });
    expect(log.entries[0]).toMatchObject({ reason: 'invalid_params' });
  });

  it('a caller without a Cell gets the same refusal as a foreign URI', async () => {
    const { streams } = build({ cellsRepo: { findCellByOwner: () => Promise.resolve(null) } });
    await expect(authorize(streams, [OWN_URI])).resolves.toMatchObject({ code: -32602 });
  });

  it('leaves a missing filter to the SDK', async () => {
    const { streams } = build();
    await expect(
      streams.authorize({ body: { method: 'subscriptions/listen' }, identity: IDENTITY }),
    ).resolves.toBeNull();
  });
});

describe('onResponse', () => {
  it('an empty list opens no presence and logs subscribesOwnMailbox false', () => {
    const { streams, subscribe, log } = build();
    const { raw, binding } = open(streams, []);

    expect(binding).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
    expect(log.entries[0]).toMatchObject({
      event: 'mcp_listen_opened',
      subscribesOwnMailbox: false,
      resourceSubscriptionsCount: 0,
    });
    raw.emit('close');
    expect(log.entries[1]).toMatchObject({
      event: 'mcp_listen_closed',
      subscribesOwnMailbox: false,
      closeReason: 'client_closed',
    });
    expect(streams.__openCount()).toBe(0);
  });

  it('a non-SSE answer of the SDK is not a stream', () => {
    const { streams, subscribe } = build();
    const binding = streams.onResponse({
      body: listenBody([OWN_URI]),
      identity: IDENTITY,
      requestId: 'r',
      response: Response.json({ jsonrpc: '2.0', error: {} }),
      raw: new FakeRaw() as unknown as ServerResponse,
      abort: vi.fn(),
    });
    expect(binding).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('calls ready() only after the acknowledgment, whichever finishes first', async () => {
    const first = fakeSubscription();
    const { streams } = build({
      presenceRegistry: {
        subscribe: () => Promise.resolve(first),
      } as unknown as PresenceRegistry,
    });
    const { binding } = open(streams);
    await Promise.resolve();
    expect(first.ready).not.toHaveBeenCalled();
    binding?.onAcknowledged();
    expect(first.ready).toHaveBeenCalledOnce();

    let release: (s: Subscription) => void = () => undefined;
    const second = fakeSubscription();
    const slow = build({
      presenceRegistry: {
        subscribe: () => new Promise<Subscription>((r) => (release = r)),
      } as unknown as PresenceRegistry,
    });
    const late = open(slow.streams);
    late.binding?.onAcknowledged();
    release(second);
    await vi.waitFor(() => {
      expect(second.ready).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ['suspended', 'participant_suspended'],
    ['revoked', 'participant_revoked'],
    ['not_found', 'participant_revoked'],
    ['registry_shut_down', 'shutdown'],
  ] as const)('a failed subscribe (%s) closes the stream with %s', async (subCode, closeReason) => {
    const { streams, log } = build({
      presenceRegistry: {
        subscribe: () =>
          Promise.reject(new WaggleError('PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE', { subCode })),
      } as unknown as PresenceRegistry,
    });

    open(streams);

    await vi.waitFor(() => {
      expect(log.entries).toContainEqual(
        expect.objectContaining({ event: 'mcp_listen_closed', closeReason }),
      );
    });
    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_subscribe_failed', subCode, closeReason }),
    );
    expect(streams.__openCount()).toBe(0);
  });

  it('logs the close once, with duration, and enables TCP keep-alive', () => {
    const { streams, log } = build();
    const { raw } = open(streams);
    expect(raw.socket.setKeepAlive).toHaveBeenCalledWith(true, 60_000);

    raw.emit('close');
    raw.emit('close');

    const closed = log.entries.filter((e) => e['event'] === 'mcp_listen_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ closeReason: 'client_closed', subscribesOwnMailbox: true });
    expect(closed[0]?.['streamDurationMs']).toEqual(expect.any(Number));
    expect(streams.__openCount()).toBe(0);
  });
});

describe('a stream with an empty list has a lifecycle, without presence', () => {
  it('writes keep-alives', () => {
    vi.useFakeTimers();
    const { streams } = build({ keepAliveIntervalMs: 1000 });
    const { raw } = open(streams, []);
    const write = vi.spyOn(raw, 'write');

    vi.advanceTimersByTime(1000);

    expect(write).toHaveBeenCalledWith(': keepalive\n\n', expect.any(Function));
    raw.emit('close');
    vi.useRealTimers();
  });

  it('closes when the credential expires', () => {
    vi.useFakeTimers();
    const { streams, log } = build();
    const expiring = {
      ...IDENTITY,
      snapshot: { ...IDENTITY.snapshot, credentialExpiresAt: new Date(Date.now() + 5000) },
    };
    const raw = new FakeRaw();
    streams.onResponse({
      body: listenBody([]),
      identity: expiring,
      requestId: '01900000-0000-7000-8000-0000000000bb',
      response: sseResponse(),
      raw: raw as unknown as ServerResponse,
      abort: vi.fn(),
    });

    vi.advanceTimersByTime(5000);

    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'credential_expired' }),
    );
    vi.useRealTimers();
  });

  it('closes on revocation through the re-verification pass', async () => {
    const { streams, subscribe, log } = build({
      verifier: {
        reverifyStream: () => Promise.resolve({ ok: false, reason: 'participant_revoked' }),
      },
    });
    const { raw } = open(streams, []);

    await streams.reverifyOpenStreams();

    expect(raw.destroyed).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        event: 'mcp_listen_closed',
        subscribesOwnMailbox: false,
        closeReason: 'participant_revoked',
      }),
    );
  });

  it('stop() ends it with complete, so the HTTP drain does not wait for it', () => {
    const { streams, log } = build();
    const { raw } = open(streams, []);
    const write = vi.spyOn(raw, 'write');

    streams.stop();

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"complete"'), expect.any(Function));
    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'shutdown' }),
    );
    expect(streams.__openCount()).toBe(0);
  });
});

describe('reverifyOpenStreams', () => {
  const verdict =
    (reason: string): Verifier['reverifyStream'] =>
    () =>
      Promise.resolve({ ok: false, reason } as never);

  it.each([
    ['credential_expired', 'credential_expired'],
    ['credential_revoked', 'participant_revoked'],
    ['participant_not_found', 'participant_revoked'],
    ['participant_revoked', 'participant_revoked'],
    ['participant_suspended', 'participant_suspended'],
  ])('%s closes the stream as %s', async (reason, closeReason) => {
    const { streams, log } = build({ verifier: { reverifyStream: verdict(reason) } });
    open(streams);

    await streams.reverifyOpenStreams();

    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason }),
    );
    expect(streams.__openCount()).toBe(0);
  });

  it('a lookup failure keeps the stream, warns, and does not abort the pass', async () => {
    const reverifyStream = vi
      .fn<Verifier['reverifyStream']>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ ok: false, reason: 'participant_revoked' });
    const { streams, log } = build({ verifier: { reverifyStream } });
    open(streams);
    open(streams);

    await streams.reverifyOpenStreams();

    expect(reverifyStream).toHaveBeenCalledTimes(2);
    expect(streams.__openCount()).toBe(1);
    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_reverify_failed' }),
    );
  });

  it('runs on a single timer and stops', async () => {
    vi.useFakeTimers();
    const reverifyStream = vi.fn<Verifier['reverifyStream']>(() => Promise.resolve({ ok: true }));
    const { streams } = build({ verifier: { reverifyStream }, reverifyIntervalSeconds: 1 });
    open(streams);

    streams.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reverifyStream).toHaveBeenCalledTimes(2);

    streams.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reverifyStream).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('an interval of 0 starts no timer', async () => {
    vi.useFakeTimers();
    const reverifyStream = vi.fn<Verifier['reverifyStream']>();
    const { streams } = build({ verifier: { reverifyStream } });
    open(streams);
    streams.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reverifyStream).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('listen lease', () => {
  const KEY = 'k'.repeat(22);
  const OTHER = {
    participantId: '01900000-0000-7000-8000-0000000000ee',
    snapshot: { credentialJti: '01900000-0000-7000-8000-0000000000ef' },
  } as unknown as IdentityContext;

  it('a listen with a lease key gets the lease length back and expires without beats', () => {
    vi.useFakeTimers();
    const { streams, log } = build({ leaseMs: 600 });
    const { raw } = open(streams, [OWN_URI], { leaseKey: KEY });

    expect(raw.headers['hive-listen-lease-ms']).toBe('600');
    expect(log.entries[0]).toMatchObject({ event: 'mcp_listen_opened', leaseMs: 600 });
    vi.advanceTimersByTime(600);

    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'lease_expired' }),
    );
    expect(streams.__openCount()).toBe(0);
    vi.useRealTimers();
  });

  it('a listen without the header has no lease and never expires', () => {
    vi.useFakeTimers();
    const { streams, log } = build({ leaseMs: 600, keepAliveIntervalMs: 24 * 60 * 60 * 1000 });
    const { raw } = open(streams);

    expect(raw.headers['hive-listen-lease-ms']).toBeUndefined();
    expect(log.entries[0]).toMatchObject({ event: 'mcp_listen_opened', leaseMs: null });
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);

    expect(streams.__openCount()).toBe(1);
    raw.emit('close');
    vi.useRealTimers();
  });

  it('a renewal by the same participant with the same key keeps the stream open', () => {
    vi.useFakeTimers();
    const { streams } = build({ leaseMs: 600 });
    const { raw } = open(streams, [OWN_URI], { leaseKey: KEY });

    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(500);
      expect(streams.renewLease({ key: KEY, identity: IDENTITY })).toBe(true);
    }

    expect(streams.__openCount()).toBe(1);
    raw.emit('close');
    vi.useRealTimers();
  });

  it('another participant carrying the same key cannot renew it', () => {
    vi.useFakeTimers();
    const { streams, log } = build({ leaseMs: 600 });
    open(streams, [OWN_URI], { leaseKey: KEY });

    vi.advanceTimersByTime(500);
    expect(streams.renewLease({ key: KEY, identity: OTHER })).toBe(false);
    vi.advanceTimersByTime(100);

    expect(log.entries).toContainEqual(
      expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'lease_expired' }),
    );
    vi.useRealTimers();
  });

  it('two participants may use the same key without touching each other', () => {
    vi.useFakeTimers();
    const { streams } = build({ leaseMs: 600 });
    const mine = open(streams, [], { leaseKey: KEY });
    open(streams, [], { leaseKey: KEY, identity: OTHER });

    vi.advanceTimersByTime(500);
    expect(streams.renewLease({ key: KEY, identity: OTHER })).toBe(true);
    vi.advanceTimersByTime(100);

    expect(streams.__openCount()).toBe(1);
    expect(mine.raw.destroyed).toBe(false);
    streams.stop();
    vi.useRealTimers();
  });

  it('an unknown key, or the key of a closed stream, renews nothing', () => {
    const { streams } = build({ leaseMs: 600 });
    expect(streams.renewLease({ key: KEY, identity: IDENTITY })).toBe(false);

    const { raw } = open(streams, [OWN_URI], { leaseKey: KEY });
    raw.emit('close');

    expect(streams.renewLease({ key: KEY, identity: IDENTITY })).toBe(false);
  });

  it.each([
    ['too short', 'short'],
    ['too long', 'k'.repeat(129)],
    ['outside the base64url alphabet', `${'k'.repeat(21)} `],
  ])('a malformed key (%s) is ignored, as if absent', (_label, key) => {
    vi.useFakeTimers();
    const { streams } = build({ leaseMs: 600 });
    const { raw } = open(streams, [OWN_URI], { leaseKey: key });

    expect(raw.headers['hive-listen-lease-ms']).toBeUndefined();
    vi.advanceTimersByTime(6000);
    expect(streams.__openCount()).toBe(1);
    raw.emit('close');
    vi.useRealTimers();
  });

  it('a disabled lease ignores the header and answers no lease length', () => {
    vi.useFakeTimers();
    const { streams } = build({ leaseMs: null });
    const { raw } = open(streams, [OWN_URI], { leaseKey: KEY });

    expect(raw.headers['hive-listen-lease-ms']).toBeUndefined();
    vi.advanceTimersByTime(6000);
    expect(streams.__openCount()).toBe(1);
    expect(streams.renewLease({ key: KEY, identity: IDENTITY })).toBe(false);
    raw.emit('close');
    vi.useRealTimers();
  });
});

// ADR-026: a register_session renewal moves the open presence streams of the Agent to
// the new token, so they survive the `exp` of the token they were opened with.
describe('rebindParticipantStreams', () => {
  const NEW_JTI = '01900000-0000-7000-8000-0000000000ee';

  function expiringIdentity(ms: number): IdentityContext {
    return {
      ...IDENTITY,
      snapshot: { ...IDENTITY.snapshot, credentialExpiresAt: new Date(Date.now() + ms) },
    };
  }

  it('re-arms the expiry on the new token: the stream outlives the original exp', () => {
    vi.useFakeTimers();
    try {
      const { streams, log } = build();
      const { raw } = open(streams, [OWN_URI], { identity: expiringIdentity(5000) });

      const rebound = streams.rebindParticipantStreams(IDENTITY.participantId, {
        jti: NEW_JTI,
        expiresAt: new Date(Date.now() + 20_000),
      });
      vi.advanceTimersByTime(10_000);

      expect(rebound).toBe(1);
      expect(raw.destroyed).toBe(false);
      expect(streams.__openCount()).toBe(1);

      vi.advanceTimersByTime(10_000);
      expect(log.entries).toContainEqual(
        expect.objectContaining({ event: 'mcp_listen_closed', closeReason: 'credential_expired' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-verifies the new jti from then on', async () => {
    const reverifyStream = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { streams } = build({ verifier: { reverifyStream } });
    open(streams, [OWN_URI]);
    const expiresAt = new Date(Date.now() + 60_000);

    streams.rebindParticipantStreams(IDENTITY.participantId, { jti: NEW_JTI, expiresAt });
    await streams.reverifyOpenStreams();

    expect(reverifyStream).toHaveBeenCalledWith({
      jti: NEW_JTI,
      participantId: IDENTITY.participantId,
      credentialExpiresAt: expiresAt,
    });
  });

  it('re-binds every presence stream of the participant, and only those', () => {
    const { streams } = build();
    const other = {
      ...IDENTITY,
      participantId: '01900000-0000-7000-8000-0000000000cc',
    };
    open(streams, [OWN_URI]);
    open(streams, [OWN_URI]);
    open(streams, []);
    open(streams, [OWN_URI], { identity: other });

    const rebound = streams.rebindParticipantStreams(IDENTITY.participantId, {
      jti: NEW_JTI,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(rebound).toBe(2);
  });

  it('answers 0 when the holder has no stream', () => {
    const { streams } = build();

    expect(
      streams.rebindParticipantStreams(IDENTITY.participantId, {
        jti: NEW_JTI,
        expiresAt: new Date(),
      }),
    ).toBe(0);
  });
});
