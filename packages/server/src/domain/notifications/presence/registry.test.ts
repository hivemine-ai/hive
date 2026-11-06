// Unit tests for the stream-bound Presence Registry. An entry lives exactly as
// long as its stream: there is no sweep, no activity timestamp and no idle threshold.
// The SubscriberHandle is mocked inline via `mockHandle()` (deliver captures
// into an array; close() and onClose() are recorded so tests can drive both
// directions of the lifecycle).

import { v7 as uuidv7 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import type { WaggleNotification } from '#domain/notifications/waggle/types.js';
import type { Logger } from '#observability/logger.js';

import { isWaggleError } from '../errors.js';

import { createPresenceRegistry } from './registry.js';
import type { PresenceRegistry, PresenceRegistryConfig } from './registry.js';
import type { StreamCloseReason, SubscriberHandle } from './subscriber-handle.js';

interface MockHandle extends SubscriberHandle {
  captured: WaggleNotification[];
  closeCalls: StreamCloseReason[];
  /** Simulates the transport detecting the stream end by itself. */
  triggerClose: (reason?: StreamCloseReason) => void;
}

function mockHandle(
  callerContext: IdentityContext,
  opts: { closeThrows?: boolean } = {},
): MockHandle {
  const captured: WaggleNotification[] = [];
  const closeCalls: StreamCloseReason[] = [];
  const listeners: Array<(reason: StreamCloseReason) => void> = [];
  let closed = false;
  const fire = (reason: StreamCloseReason): void => {
    if (closed) return;
    closed = true;
    for (const cb of listeners.splice(0)) cb(reason);
  };
  return {
    connectionId: uuidv7(),
    callerContext,
    captured,
    closeCalls,
    deliver(notification: WaggleNotification) {
      captured.push(notification);
      return Promise.resolve();
    },
    close(reason: StreamCloseReason) {
      closeCalls.push(reason);
      if (opts.closeThrows === true) throw new Error('close exploded');
      fire(reason);
    },
    onClose(cb: (reason: StreamCloseReason) => void) {
      listeners.push(cb);
    },
    triggerClose(reason: StreamCloseReason = 'client_closed') {
      fire(reason);
    },
  };
}

function activeContext(participantId?: UUIDv7): IdentityContext {
  const id = participantId ?? uuidv7();
  return {
    participantId: id,
    kind: 'worker',
    hiveId: uuidv7(),
    hiveName: 'test-hive',
    colonyId: uuidv7(),
    ownerId: uuidv7(),
    snapshot: {
      issuedAt: new Date(),
      credentialJti: uuidv7(),
      credentialKid: 'kid-1',
    },
    current: { state: 'active', type: 'worker' },
  };
}

function nonActiveContext(state: 'suspended' | 'revoked'): IdentityContext {
  // The verifier types `current.state` as 'active'; the registry must still
  // refuse anything else as defense-in-depth.
  return {
    ...activeContext(),
    current: { state, type: 'worker' } as unknown as IdentityContext['current'],
  };
}

function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  events: () => Array<Record<string, unknown>>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    info,
    warn,
    error,
    events: () =>
      [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls].map(
        (c) => c[0] as Record<string, unknown>,
      ),
  };
}

let registry: PresenceRegistry | undefined;

function build(config: PresenceRegistryConfig = {}): PresenceRegistry {
  registry = createPresenceRegistry(config);
  return registry;
}

afterEach(() => {
  registry?.shutdown();
  registry = undefined;
  vi.useRealTimers();
});

describe('subscribe → ready() lifecycle', () => {
  it('a fresh entry is pending: not online until ready()', async () => {
    const reg = build();
    const ctx = activeContext();

    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sub.participantId).toBe(ctx.participantId);
    expect(reg.getPresence(ctx.participantId)).toEqual({
      online: false,
      streamCount: 0,
      streamsSubscribedAt: [],
    });
    expect(reg.isOpen(sub.id, ctx.participantId)).toBe(false);
  });

  it('ready() flips pending → open: online, streamCount and streamsSubscribedAt', async () => {
    const reg = build();
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    sub.ready();

    const snapshot = reg.getPresence(ctx.participantId);
    expect(snapshot.online).toBe(true);
    expect(snapshot.streamCount).toBe(1);
    expect(snapshot.streamsSubscribedAt).toEqual([sub.subscribedAt]);
    expect(reg.isOpen(sub.id, ctx.participantId)).toBe(true);
  });

  it('ready() is idempotent and a no-op once the entry is gone', async () => {
    const onReady = vi.fn();
    const reg = build({ onReady });
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    sub.ready();
    sub.ready();
    expect(onReady).toHaveBeenCalledTimes(1);

    const sub2 = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub2.close();
    sub2.ready();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(reg.getPresence(ctx.participantId).streamCount).toBe(1);
  });

  it('ready() fires the onReady hook with participant, subscription and handle; subscribe does not', async () => {
    const onReady = vi.fn();
    const reg = build({ onReady });
    const ctx = activeContext();
    const handle = mockHandle(ctx);

    const sub = await reg.subscribe({ callerContext: ctx, handle });
    expect(onReady).not.toHaveBeenCalled();

    sub.ready();
    expect(onReady).toHaveBeenCalledWith({
      participantId: ctx.participantId,
      subscriptionId: sub.id,
      handle,
    });
  });

  it('a throwing onReady hook does not break ready()', async () => {
    const reg = build({
      onReady: () => {
        throw new Error('hook bug');
      },
    });
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(() => {
      sub.ready();
    }).not.toThrow();
    expect(reg.getPresence(ctx.participantId).online).toBe(true);
  });

  it('only open streams count: a pending sibling is not counted', async () => {
    const reg = build();
    const ctx = activeContext();
    const a = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    a.ready();

    expect(reg.getPresence(ctx.participantId).streamCount).toBe(1);
  });

  it('a participant that never subscribed is offline (tool-only agents are not online)', () => {
    const reg = build();
    expect(reg.getPresence(uuidv7())).toEqual({
      online: false,
      streamCount: 0,
      streamsSubscribedAt: [],
    });
  });
});

describe('subscribe preconditions', () => {
  it('rejects when the snapshot state is suspended', async () => {
    const reg = build();
    const ctx = nonActiveContext('suspended');

    await expect(reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) &&
        err.code === 'PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE' &&
        err.subCode === 'suspended',
    );
  });

  it('rejects when the snapshot state is revoked', async () => {
    const reg = build();
    const ctx = nonActiveContext('revoked');

    await expect(reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).rejects.toSatisfy(
      (err) => isWaggleError(err) && err.subCode === 'revoked',
    );
  });

  it('re-reads the live state from the repo and rejects a suspension the snapshot missed', async () => {
    const getParticipantState = vi.fn().mockResolvedValue({ state: 'suspended' });
    const reg = build({ participantsRepo: { getParticipantState } });
    const ctx = activeContext();

    await expect(reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) &&
        err.code === 'PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE' &&
        err.subCode === 'suspended',
    );
    expect(getParticipantState).toHaveBeenCalledWith(ctx.participantId);
    expect(reg.getPresence(ctx.participantId).online).toBe(false);
  });

  it('accepts when the live state is active', async () => {
    const getParticipantState = vi.fn().mockResolvedValue({ state: 'active' });
    const reg = build({ participantsRepo: { getParticipantState } });
    const ctx = activeContext();

    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();

    expect(reg.getPresence(ctx.participantId).online).toBe(true);
  });

  it('subscribe does not write last_connected_at (auth-binding owns it)', async () => {
    const updateAgentLastConnectedAt = vi.fn();
    const reg = build({
      participantsRepo: {
        getParticipantState: vi.fn().mockResolvedValue({ state: 'active' }),
        updateAgentLastConnectedAt,
      } as unknown as NonNullable<PresenceRegistryConfig['participantsRepo']>,
    });
    const ctx = activeContext();

    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();
    await Promise.resolve();

    expect(updateAgentLastConnectedAt).not.toHaveBeenCalled();
  });
});

describe('entries live exactly as long as their stream', () => {
  it('an idle entry stays registered for any amount of time (fake clock)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    const reg = build();
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();

    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);

    expect(reg.getPresence(ctx.participantId).online).toBe(true);
    expect(reg.getPresence(ctx.participantId).streamCount).toBe(1);
  });

  it('the registry mounts no timers', async () => {
    vi.useFakeTimers();
    const reg = build();
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('the entry disappears when its handle closes (onClose)', async () => {
    const reg = build();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    const sub = await reg.subscribe({ callerContext: ctx, handle });
    sub.ready();

    handle.triggerClose('stalled');

    expect(reg.getPresence(ctx.participantId).online).toBe(false);
    expect(reg.isOpen(sub.id, ctx.participantId)).toBe(false);
  });

  it('two streams: closing one keeps the participant online', async () => {
    const reg = build();
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);
    const s1 = await reg.subscribe({ callerContext: ctx, handle: h1 });
    const s2 = await reg.subscribe({ callerContext: ctx, handle: h2 });
    s1.ready();
    s2.ready();
    expect(reg.getPresence(ctx.participantId).streamCount).toBe(2);

    h1.triggerClose();

    const snapshot = reg.getPresence(ctx.participantId);
    expect(snapshot.online).toBe(true);
    expect(snapshot.streamCount).toBe(1);
  });

  it('subscription.close() removes the entry without closing the physical stream', async () => {
    const reg = build();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    const sub = await reg.subscribe({ callerContext: ctx, handle });
    sub.ready();

    sub.close();

    expect(reg.getPresence(ctx.participantId).online).toBe(false);
    expect(handle.closeCalls).toEqual([]);
  });

  it('subscription.close() is idempotent', async () => {
    const reg = build();
    const ctx = activeContext();
    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();

    sub.close();
    expect(() => {
      sub.close();
    }).not.toThrow();
  });

  it('unsubscribe with an unknown subscriptionId is a no-op', () => {
    const reg = build();
    expect(() => {
      reg.unsubscribe(uuidv7(), uuidv7(), 'client_closed');
    }).not.toThrow();
  });

  it('unsubscribe never calls handle.close() (the stream is already gone)', async () => {
    const reg = build();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    const sub = await reg.subscribe({ callerContext: ctx, handle });
    sub.ready();

    reg.unsubscribe(sub.id, ctx.participantId, 'write_failed');

    expect(handle.closeCalls).toEqual([]);
    expect(reg.getPresence(ctx.participantId).online).toBe(false);
  });

  it('a second subscribe with the same connectionId replaces the first entry', async () => {
    const reg = build();
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2: MockHandle = { ...mockHandle(ctx), connectionId: h1.connectionId };
    const s1 = await reg.subscribe({ callerContext: ctx, handle: h1 });
    s1.ready();
    const s2 = await reg.subscribe({ callerContext: ctx, handle: h2 });
    s2.ready();

    expect(reg.getPresence(ctx.participantId).streamCount).toBe(1);
    expect(reg.isOpen(s1.id, ctx.participantId)).toBe(false);
    expect(reg.isOpen(s2.id, ctx.participantId)).toBe(true);
  });
});

describe('cap and LRU eviction (no inactivity threshold)', () => {
  it('at the cap, the oldest stream receives close("evicted_lru") and the new one registers', async () => {
    let t = 1_000;
    const reg = build({ maxSessionsPerParticipant: 2, now: () => new Date(t) });
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);
    const h3 = mockHandle(ctx);
    const s1 = await reg.subscribe({ callerContext: ctx, handle: h1 });
    s1.ready();
    t += 10;
    const s2 = await reg.subscribe({ callerContext: ctx, handle: h2 });
    s2.ready();
    t += 10;

    const s3 = await reg.subscribe({ callerContext: ctx, handle: h3 });
    s3.ready();

    expect(h1.closeCalls).toEqual(['evicted_lru']);
    expect(h2.closeCalls).toEqual([]);
    expect(reg.isOpen(s1.id, ctx.participantId)).toBe(false);
    expect(reg.isOpen(s2.id, ctx.participantId)).toBe(true);
    expect(reg.isOpen(s3.id, ctx.participantId)).toBe(true);
    expect(reg.getPresence(ctx.participantId).streamCount).toBe(2);
  });

  it('subscribe never rejects for the cap', async () => {
    const reg = build({ maxSessionsPerParticipant: 1 });
    const ctx = activeContext();
    for (let i = 0; i < 5; i++) {
      await expect(
        reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
      ).resolves.toBeDefined();
    }
  });

  it('eviction ignores inactivity: traffic does not protect a stream from being the oldest', async () => {
    let t = 1_000;
    const reg = build({ maxSessionsPerParticipant: 2, now: () => new Date(t) });
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const s1 = await reg.subscribe({ callerContext: ctx, handle: h1 });
    s1.ready();
    t += 10;
    const s2 = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    s2.ready();
    await reg.forEachSubscriber(ctx.participantId, async (h) => {
      await h.deliver({} as WaggleNotification);
    });

    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(h1.closeCalls).toEqual(['evicted_lru']);
  });

  it('a pending entry counts toward the cap and can be the victim', async () => {
    let t = 1_000;
    const reg = build({ maxSessionsPerParticipant: 1, now: () => new Date(t) });
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const s1 = await reg.subscribe({ callerContext: ctx, handle: h1 });
    t += 10;

    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(h1.closeCalls).toEqual(['evicted_lru']);
    s1.ready();
    expect(reg.getPresence(ctx.participantId).streamCount).toBe(0);
  });

  it('a victim whose close() throws is logged and does not abort the subscribe', async () => {
    const logger = makeLogger();
    const reg = build({
      maxSessionsPerParticipant: 1,
      logger: logger as unknown as Logger,
    });
    const ctx = activeContext();
    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx, { closeThrows: true }) });

    const sub = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    sub.ready();

    expect(reg.getPresence(ctx.participantId).streamCount).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('the cap is per participant', async () => {
    const reg = build({ maxSessionsPerParticipant: 1 });
    const a = activeContext();
    const b = activeContext();
    const ha = mockHandle(a);
    const sa = await reg.subscribe({ callerContext: a, handle: ha });
    sa.ready();

    const sb = await reg.subscribe({ callerContext: b, handle: mockHandle(b) });
    sb.ready();

    expect(ha.closeCalls).toEqual([]);
    expect(reg.getPresence(a.participantId).online).toBe(true);
    expect(reg.getPresence(b.participantId).online).toBe(true);
  });
});

describe('listOpenStreams', () => {
  it('lists only open entries, each with its subscription', async () => {
    const registry = build();
    const context = activeContext();
    const opened = await registry.subscribe({
      callerContext: context,
      handle: mockHandle(context),
    });
    opened.ready();
    await registry.subscribe({ callerContext: context, handle: mockHandle(context) });

    const streams = registry.listOpenStreams(context.participantId);
    expect(streams.map((s) => s.subscriptionId)).toEqual([opened.id]);
    expect(registry.listOpenStreams(uuidv7())).toEqual([]);
  });
});

describe('closeParticipantStreams', () => {
  it('closes every stream of the participant with the reason and removes the entries', async () => {
    const reg = build();
    const ctx = activeContext();
    const other = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);
    const ho = mockHandle(other);
    (await reg.subscribe({ callerContext: ctx, handle: h1 })).ready();
    (await reg.subscribe({ callerContext: ctx, handle: h2 })).ready();
    (await reg.subscribe({ callerContext: other, handle: ho })).ready();

    reg.closeParticipantStreams(ctx.participantId, 'participant_revoked');

    expect(h1.closeCalls).toEqual(['participant_revoked']);
    expect(h2.closeCalls).toEqual(['participant_revoked']);
    expect(ho.closeCalls).toEqual([]);
    expect(reg.getPresence(ctx.participantId).online).toBe(false);
    expect(reg.getPresence(other.participantId).online).toBe(true);
  });

  it('a throwing handle does not stop the others; unknown participants are a no-op', async () => {
    const logger = makeLogger();
    const reg = build({ logger: logger as unknown as Logger });
    const ctx = activeContext();
    const bad = mockHandle(ctx, { closeThrows: true });
    const good = mockHandle(ctx);
    (await reg.subscribe({ callerContext: ctx, handle: bad })).ready();
    (await reg.subscribe({ callerContext: ctx, handle: good })).ready();

    reg.closeParticipantStreams(ctx.participantId, 'participant_suspended');
    reg.closeParticipantStreams(uuidv7(), 'participant_suspended');

    expect(good.closeCalls).toEqual(['participant_suspended']);
    expect(reg.getPresence(ctx.participantId).online).toBe(false);
  });
});

describe('shutdown', () => {
  it('closes all streams with "shutdown", empties the registry and is idempotent', async () => {
    const reg = build();
    const a = activeContext();
    const b = activeContext();
    const ha = mockHandle(a);
    const hb = mockHandle(b);
    (await reg.subscribe({ callerContext: a, handle: ha })).ready();
    (await reg.subscribe({ callerContext: b, handle: hb })).ready();

    reg.shutdown();
    reg.shutdown();

    expect(ha.closeCalls).toEqual(['shutdown']);
    expect(hb.closeCalls).toEqual(['shutdown']);
    expect(reg.getPresence(a.participantId).online).toBe(false);
  });

  it('rejects subscribes after shutdown with INVALID_INPUT/registry_shut_down', async () => {
    const reg = build();
    reg.shutdown();
    const ctx = activeContext();

    await expect(reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) && err.code === 'INVALID_INPUT' && err.subCode === 'registry_shut_down',
    );
  });
});

describe('forEachSubscriber', () => {
  it('fans out only to open entries and isolates errors per handle', async () => {
    const reg = build();
    const ctx = activeContext();
    const openA = mockHandle(ctx);
    const openB = mockHandle(ctx);
    const pending = mockHandle(ctx);
    (await reg.subscribe({ callerContext: ctx, handle: openA })).ready();
    (await reg.subscribe({ callerContext: ctx, handle: openB })).ready();
    await reg.subscribe({ callerContext: ctx, handle: pending });

    const seen: SubscriberHandle[] = [];
    const errors: unknown[] = [];
    await reg.forEachSubscriber(
      ctx.participantId,
      async (h) => {
        seen.push(h);
        if (h === openA) throw new Error('zombie');
        await h.deliver({} as WaggleNotification);
      },
      (_h, err) => errors.push(err),
    );

    expect(seen).toEqual([openA, openB]);
    expect(errors).toHaveLength(1);
    expect(openB.captured).toHaveLength(1);
    expect(pending.captured).toHaveLength(0);
  });

  it('survives a handle that unsubscribes itself mid-iteration', async () => {
    const reg = build();
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);
    (await reg.subscribe({ callerContext: ctx, handle: h1 })).ready();
    (await reg.subscribe({ callerContext: ctx, handle: h2 })).ready();

    const seen: SubscriberHandle[] = [];
    await reg.forEachSubscriber(ctx.participantId, (h) => {
      seen.push(h);
      h1.triggerClose();
      return Promise.resolve();
    });

    expect(seen).toHaveLength(2);
  });

  it('absent participant returns immediately', async () => {
    const reg = build();
    await expect(reg.forEachSubscriber(uuidv7(), () => Promise.resolve())).resolves.toBeUndefined();
  });
});

describe('presence events', () => {
  function eventsNamed(
    logger: ReturnType<typeof makeLogger>,
    name: string,
  ): Array<Record<string, unknown>> {
    return logger.events().filter((e) => e['event'] === name);
  }

  it('emits presence_stream_online on 0 → 1 open streams only', async () => {
    const logger = makeLogger();
    const reg = build({ logger: logger as unknown as Logger });
    const ctx = activeContext();
    const s1 = await reg.subscribe({
      callerContext: ctx,
      handle: mockHandle(ctx),
      requestId: 'req-1',
    });
    expect(eventsNamed(logger, 'presence_stream_online')).toHaveLength(0);

    s1.ready();
    (await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).ready();

    const online = eventsNamed(logger, 'presence_stream_online');
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({
      participantId: ctx.participantId,
      streamCount: 1,
      requestId: 'req-1',
    });
  });

  it('emits presence_stream_offline with closeReason when the last open stream goes', async () => {
    let t = 1_000;
    const logger = makeLogger();
    const reg = build({
      logger: logger as unknown as Logger,
      now: () => new Date(t),
    });
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);
    (await reg.subscribe({ callerContext: ctx, handle: h1, requestId: 'req-a' })).ready();
    (await reg.subscribe({ callerContext: ctx, handle: h2 })).ready();

    h1.triggerClose('client_closed');
    expect(eventsNamed(logger, 'presence_stream_offline')).toHaveLength(0);

    t += 250;
    h2.triggerClose('stalled');

    const offline = eventsNamed(logger, 'presence_stream_offline');
    expect(offline).toHaveLength(1);
    expect(offline[0]).toMatchObject({
      participantId: ctx.participantId,
      closeReason: 'stalled',
      streamDurationMs: 250,
    });
  });

  it('a pending entry that drops emits no offline event', async () => {
    const logger = makeLogger();
    const reg = build({ logger: logger as unknown as Logger });
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    await reg.subscribe({ callerContext: ctx, handle });

    handle.triggerClose();

    expect(eventsNamed(logger, 'presence_stream_offline')).toHaveLength(0);
  });

  it('LRU emits presence_stream_evicted_lru and offline with closeReason evicted_lru', async () => {
    const logger = makeLogger();
    const reg = build({
      maxSessionsPerParticipant: 1,
      logger: logger as unknown as Logger,
    });
    const ctx = activeContext();
    const first = await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    first.ready();

    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(eventsNamed(logger, 'presence_stream_evicted_lru')[0]).toMatchObject({
      participantId: ctx.participantId,
      victimSubscriptionId: first.id,
    });
    expect(eventsNamed(logger, 'presence_stream_offline')[0]).toMatchObject({
      closeReason: 'evicted_lru',
    });
  });

  it('never emits the retired idle-sweep events', async () => {
    const logger = makeLogger();
    const reg = build({
      maxSessionsPerParticipant: 1,
      logger: logger as unknown as Logger,
    });
    const ctx = activeContext();
    (await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) })).ready();
    await reg.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    const names = logger.events().map((e) => e['event']);
    expect(names.filter((n) => String(n).startsWith('presence_session_'))).toEqual([]);
    expect(names).not.toContain('presence_subscribe_success');
  });
});

// ADR-026: holder liveness and the claim reservation of register_session.
describe('isHolderLive / claimHolder / releaseClaim', () => {
  const RESERVATION_MS = 10_000;

  function buildWithClock(): { registry: PresenceRegistry; advance: (ms: number) => void } {
    let nowMs = Date.parse('2026-11-06T12:00:00.000Z');
    const registry = createPresenceRegistry({
      now: () => new Date(nowMs),
      claimReservationMs: RESERVATION_MS,
    });
    return {
      registry,
      advance: (ms) => {
        nowMs += ms;
      },
    };
  }

  async function openStream(registry: PresenceRegistry, ctx: IdentityContext): Promise<MockHandle> {
    const handle = mockHandle(ctx);
    const subscription = await registry.subscribe({ callerContext: ctx, handle });
    subscription.ready();
    return handle;
  }

  it('isHolderLive is true only while an open entry exists', async () => {
    const { registry } = buildWithClock();
    const ctx = activeContext();
    expect(registry.isHolderLive(ctx.participantId)).toBe(false);

    const handle = mockHandle(ctx);
    const subscription = await registry.subscribe({ callerContext: ctx, handle });
    expect(registry.isHolderLive(ctx.participantId)).toBe(false);

    subscription.ready();
    expect(registry.isHolderLive(ctx.participantId)).toBe(true);

    handle.triggerClose('lease_expired');
    expect(registry.isHolderLive(ctx.participantId)).toBe(false);
  });

  it('claimHolder answers in_use while the holder has an open stream', async () => {
    const { registry } = buildWithClock();
    const ctx = activeContext();
    await openStream(registry, ctx);

    expect(registry.claimHolder(ctx.participantId, uuidv7())).toEqual({ outcome: 'in_use' });
  });

  it('grants one of two claims on an offline holder; the other gets in_use', () => {
    const { registry } = buildWithClock();
    const agentId = uuidv7();

    const first = registry.claimHolder(agentId, uuidv7());
    const second = registry.claimHolder(agentId, uuidv7());

    expect(first).toEqual({ outcome: 'granted' });
    expect(second).toEqual({ outcome: 'in_use' });
  });

  it('is idempotent per claimId and does not extend the reservation', () => {
    const { registry, advance } = buildWithClock();
    const agentId = uuidv7();
    const claimId = uuidv7();

    expect(registry.claimHolder(agentId, claimId)).toEqual({ outcome: 'granted' });
    advance(RESERVATION_MS - 1);
    expect(registry.claimHolder(agentId, claimId)).toEqual({ outcome: 'granted' });
    advance(1);
    // The first reservation expired at its original time, so another claim wins.
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'granted' });
  });

  it('lets a new claim win once the reservation expired without a stream', () => {
    const { registry, advance } = buildWithClock();
    const agentId = uuidv7();
    registry.claimHolder(agentId, uuidv7());

    advance(RESERVATION_MS - 1);
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'in_use' });
    advance(1);
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'granted' });
  });

  it('releaseClaim frees only the reservation of that claimId, idempotently', () => {
    const { registry } = buildWithClock();
    const agentId = uuidv7();
    const claimId = uuidv7();
    registry.claimHolder(agentId, claimId);

    registry.releaseClaim(agentId, uuidv7());
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'in_use' });

    registry.releaseClaim(agentId, claimId);
    registry.releaseClaim(agentId, claimId);
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'granted' });
  });

  it('ready() of the claimant consumes the reservation: the stream is the holder now', async () => {
    const { registry } = buildWithClock();
    const ctx = activeContext();
    const claimId = uuidv7();
    registry.claimHolder(ctx.participantId, claimId);

    const handle = await openStream(registry, ctx);
    handle.triggerClose('client_closed');

    // Without the reservation the offline holder is claimable again right away.
    expect(registry.claimHolder(ctx.participantId, uuidv7())).toEqual({ outcome: 'granted' });
  });

  it('defaults the reservation to 10 s', () => {
    let nowMs = 0;
    const registry = createPresenceRegistry({ now: () => new Date(nowMs) });
    const agentId = uuidv7();
    registry.claimHolder(agentId, uuidv7());

    nowMs = 9_999;
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'in_use' });
    nowMs = 10_000;
    expect(registry.claimHolder(agentId, uuidv7())).toEqual({ outcome: 'granted' });
  });
});
