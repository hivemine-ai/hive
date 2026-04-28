// Unit tests for the Presence Registry. The SubscriberHandle is mocked inline
// via `mockHandle()` (deliver captures into an array; onClose stores the
// callback for explicit triggering).

import { v7 as uuidv7 } from 'uuid';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

import type { SubscriberHandle } from './subscriber-handle.js';
import type { WaggleNotification } from '../waggle/types.js';
import { createPresenceRegistry } from './registry.js';
import type { PresenceRegistry } from './registry.js';
import { isWaggleError } from '../errors.js';

interface MockHandle extends SubscriberHandle {
  captured: WaggleNotification[];
  triggerClose: () => void;
}

function mockHandle(callerContext: IdentityContext): MockHandle {
  const captured: WaggleNotification[] = [];
  let onCloseCb: (() => void) | null = null;
  return {
    connectionId: uuidv7(),
    callerContext,
    captured,
    deliver(notification: WaggleNotification) {
      captured.push(notification);
      return Promise.resolve();
    },
    onClose(cb: () => void) {
      onCloseCb = cb;
    },
    triggerClose() {
      onCloseCb?.();
    },
  };
}

function activeContext(participantId?: UUIDv7): IdentityContext {
  const id = participantId ?? uuidv7();
  return {
    participantId: id,
    kind: 'worker',
    hiveId: uuidv7(),
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
  // Construct a context whose `current.state` is not 'active'. We cast through
  // `unknown` because `CurrentParticipantState.state` is typed as the string
  // literal 'active' by construction of the verifier; the registry MUST still
  // refuse it as defense-in-depth.
  return {
    ...activeContext(),
    current: { state, type: 'worker' } as unknown as IdentityContext['current'],
  };
}

describe('createPresenceRegistry', () => {
  it('subscribe → getPresence reports online with sessionCount 1', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const handle = mockHandle(ctx);

    const sub = await registry.subscribe({ callerContext: ctx, handle });

    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sub.participantId).toBe(ctx.participantId);
    const snapshot = registry.getPresence(ctx.participantId);
    expect(snapshot.online).toBe(true);
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.sessionsSubscribedAt).toHaveLength(1);
  });

  it('subscribe rejects when state !== active (defense-in-depth)', async () => {
    const registry = createPresenceRegistry();
    const ctx = nonActiveContext('suspended');

    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).rejects.toSatisfy((err) => {
      if (!isWaggleError(err)) return false;
      return err.code === 'PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE' && err.subCode === 'suspended';
    });
  });

  it('subscribe rejects when revoked', async () => {
    const registry = createPresenceRegistry();
    const ctx = nonActiveContext('revoked');

    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).rejects.toSatisfy((err) => isWaggleError(err) && err.subCode === 'revoked');
  });

  it('cap is enforced — exceeding maxSessionsPerParticipant rejects with INVALID_INPUT/too_many_sessions', async () => {
    const registry = createPresenceRegistry({ maxSessionsPerParticipant: 2 });
    const ctx = activeContext();

    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) && err.code === 'INVALID_INPUT' && err.subCode === 'too_many_sessions',
    );
  });

  it('subscription.close() removes the entry; getPresence flips to offline', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    const sub = await registry.subscribe({ callerContext: ctx, handle });

    sub.close();

    expect(registry.getPresence(ctx.participantId).online).toBe(false);
    expect(registry.getPresence(ctx.participantId).sessionCount).toBe(0);
  });

  it('subscription.close() is idempotent', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    sub.close();
    expect(() => sub.close()).not.toThrow();
  });

  it('handle.onClose() trigger removes the entry', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    await registry.subscribe({ callerContext: ctx, handle });

    handle.triggerClose();

    expect(registry.getPresence(ctx.participantId).online).toBe(false);
  });

  it('two simultaneous sessions: getPresence reports sessionCount 2; closing one keeps online', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const h1 = mockHandle(ctx);
    const h2 = mockHandle(ctx);

    const sub1 = await registry.subscribe({ callerContext: ctx, handle: h1 });
    await registry.subscribe({ callerContext: ctx, handle: h2 });

    expect(registry.getPresence(ctx.participantId).sessionCount).toBe(2);

    sub1.close();

    expect(registry.getPresence(ctx.participantId).online).toBe(true);
    expect(registry.getPresence(ctx.participantId).sessionCount).toBe(1);
  });

  it('forEachSubscriber fans out to all handles; a thrower does not abort the others', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const goodA = mockHandle(ctx);
    const bad: MockHandle = { ...mockHandle(ctx) };
    bad.deliver = () => Promise.reject(new Error('socket dead'));
    const goodB = mockHandle(ctx);

    await registry.subscribe({ callerContext: ctx, handle: goodA });
    await registry.subscribe({ callerContext: ctx, handle: bad });
    await registry.subscribe({ callerContext: ctx, handle: goodB });

    const errors: Array<{ handle: SubscriberHandle; err: unknown }> = [];
    const notif: WaggleNotification = {
      kind: 'online',
      cellId: uuidv7(),
      recipientId: ctx.participantId,
      unreadCount: 1,
      senderIds: [uuidv7()],
      emittedAt: new Date(),
      waggleId: uuidv7(),
    };

    await registry.forEachSubscriber(
      ctx.participantId,
      async (h) => {
        await h.deliver(notif);
      },
      (h, err) => {
        errors.push({ handle: h, err });
      },
    );

    expect(goodA.captured).toHaveLength(1);
    expect(goodB.captured).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.handle).toBe(bad);
  });

  it('forEachSubscriber on absent participant returns immediately (no error)', async () => {
    const registry = createPresenceRegistry();
    await expect(
      registry.forEachSubscriber(uuidv7(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it('unsubscribe with unknown subscriptionId is a no-op (idempotent)', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(() => registry.unsubscribe(uuidv7(), ctx.participantId)).not.toThrow();
    expect(registry.getPresence(ctx.participantId).online).toBe(true);
  });

  it('unsubscribe removes the entry from the participant Map and prunes the participant when empty', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    registry.unsubscribe(sub.id, ctx.participantId);

    expect(registry.__sessionCount(ctx.participantId)).toBe(0);
    expect(registry.getPresence(ctx.participantId).online).toBe(false);
  });

  it('handle reuse (same connectionId across subscribes) overwrites the prior entry', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const sharedConnectionId = uuidv7();

    const handleA: MockHandle = mockHandle(ctx);
    Object.assign(handleA, { connectionId: sharedConnectionId });
    const handleB: MockHandle = mockHandle(ctx);
    Object.assign(handleB, { connectionId: sharedConnectionId });

    await registry.subscribe({ callerContext: ctx, handle: handleA });
    await registry.subscribe({ callerContext: ctx, handle: handleB });

    expect(registry.__sessionCount(ctx.participantId)).toBe(1);
  });

  it('onSubscribed hook fires AFTER the registry mutation with the right inputs', async () => {
    const calls: Array<{
      participantId: UUIDv7;
      subscriptionId: UUIDv7;
      handle: SubscriberHandle;
    }> = [];
    const registry = createPresenceRegistry({
      onSubscribed: (input) => {
        calls.push(input);
      },
    });
    const ctx = activeContext();
    const handle = mockHandle(ctx);

    const sub = await registry.subscribe({ callerContext: ctx, handle });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.participantId).toBe(ctx.participantId);
    expect(calls[0]?.subscriptionId).toBe(sub.id);
    expect(calls[0]?.handle).toBe(handle);
  });

  it('onSubscribed hook that throws does not break subscribe', async () => {
    const registry = createPresenceRegistry({
      onSubscribed: () => {
        throw new Error('hook bug');
      },
    });
    const ctx = activeContext();

    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).resolves.toBeDefined();
    expect(registry.getPresence(ctx.participantId).online).toBe(true);
  });

  it('touch is a no-op when heartbeat is disabled (default)', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(() => registry.touch(sub.id, ctx.participantId)).not.toThrow();
  });

  it('touch updates lastSeenAt when heartbeat is enabled (smoke check via no-throw)', async () => {
    const registry = createPresenceRegistry({ heartbeatTimeoutMs: 5_000 });
    const ctx = activeContext();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    // We cannot inspect lastSeenAt directly, but the call must not throw nor
    // mutate visible state.
    expect(() => registry.touch(sub.id, ctx.participantId)).not.toThrow();
    expect(registry.getPresence(ctx.participantId).online).toBe(true);
  });

  it('subscription.subscribedAt is set to a fresh Date', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const before = Date.now();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    const after = Date.now();

    expect(sub.subscribedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(sub.subscribedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('verifies onClose wired by the registry triggers unsubscribe', async () => {
    const registry = createPresenceRegistry();
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    const onCloseSpy = vi.fn();
    handle.onClose = (cb: () => void) => {
      // Capture the callback the registry installs and re-emit on a manual trigger.
      onCloseSpy.mockImplementation(cb);
    };
    await registry.subscribe({ callerContext: ctx, handle });

    onCloseSpy(); // simulate transport close

    expect(registry.getPresence(ctx.participantId).online).toBe(false);
  });
});

// ---------- Slice 2: TTL passive sweep + LRU eviction at cap-hit ----------
// Per ADR-012 and PRY-017. Driven by INC-2026-003 (sev-2 — persistent session
// leak / cap=16 without auto-eviction). Tests use an injected `now` clock so
// the sweep + LRU thresholds are deterministic without real timers.

describe('createPresenceRegistry — Slice 2 (TTL passive + LRU eviction)', () => {
  let nowMs: number;
  const clock = (): Date => new Date(nowMs);
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  // Pino-shaped silent logger for assertions. We assert via `vi.fn()` spies.
  const silentLogger = (): {
    logger: Logger;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  } => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    return {
      logger: { info, warn, error } as unknown as Logger,
      info,
      warn,
      error,
    };
  };

  let registry: PresenceRegistry | null = null;

  beforeEach(() => {
    nowMs = new Date('2026-04-28T10:00:00Z').getTime();
  });

  afterEach(() => {
    registry?.shutdown();
    registry = null;
  });

  it('idleTimeoutMs=null disables the sweep — entries persist past any timeout', async () => {
    const { logger, info } = silentLogger();
    registry = createPresenceRegistry({
      idleTimeoutMs: null,
      sweepIntervalMs: 1_000,
      now: clock,
      logger,
    });
    const ctx = activeContext();
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    advance(60 * 60 * 1000); // 1 hour
    registry.__sweepStale(clock());

    expect(registry.__sessionCount(ctx.participantId)).toBe(1);
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'presence_session_evicted_idle' }),
      expect.any(String),
    );
  });

  it('sweep evicts stale entries when lastSeenAt > idleTimeoutMs', async () => {
    const { logger, info } = silentLogger();
    registry = createPresenceRegistry({
      idleTimeoutMs: 10 * 60 * 1000, // 10 min
      sweepIntervalMs: 60 * 1000, // 1 min
      now: clock,
      logger,
    });
    const ctx = activeContext();
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(registry.__sessionCount(ctx.participantId)).toBe(1);

    advance(11 * 60 * 1000); // 11 min — past idleTimeout
    registry.__sweepStale(clock());

    expect(registry.__sessionCount(ctx.participantId)).toBe(0);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'presence_session_evicted_idle',
        participantId: ctx.participantId,
      }),
      expect.any(String),
    );
  });

  it('sweep does not touch active entries (lastSeenAt within window)', async () => {
    registry = createPresenceRegistry({
      idleTimeoutMs: 10 * 60 * 1000,
      sweepIntervalMs: 60 * 1000,
      now: clock,
    });
    const ctx = activeContext();
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    advance(5 * 60 * 1000); // 5 min — within window
    registry.__sweepStale(clock());

    expect(registry.__sessionCount(ctx.participantId)).toBe(1);
  });

  it('shutdown() stops the periodic sweep — no further evictions', async () => {
    vi.useFakeTimers();
    try {
      const { logger, info } = silentLogger();
      registry = createPresenceRegistry({
        idleTimeoutMs: 1_000,
        sweepIntervalMs: 100,
        // Use Date.now-based clock so vitest fake timers advance it together.
        logger,
      });
      const ctx = activeContext();
      await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

      registry.shutdown();
      // Advance past several sweep intervals + the idle timeout. Even though
      // the entry is now stale, the shutdown timer is gone — no eviction.
      vi.advanceTimersByTime(5_000);

      expect(registry.__sessionCount(ctx.participantId)).toBe(1);
      expect(info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'presence_session_evicted_idle' }),
        expect.any(String),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('LRU evicts oldest at cap-hit when threshold met — new subscribe succeeds', async () => {
    const { logger, info } = silentLogger();
    registry = createPresenceRegistry({
      maxSessionsPerParticipant: 2,
      idleTimeoutMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      lruEvictThresholdMs: 15 * 60 * 1000,
      now: clock,
      logger,
    });
    const ctx = activeContext();

    // First subscribe at t=0
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    advance(20 * 60 * 1000); // 20 min later — first entry is now 20 min idle
    // Second subscribe at t=20min
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    expect(registry.__sessionCount(ctx.participantId)).toBe(2);

    // Third subscribe — cap hit. Oldest is 20 min idle, threshold is 15 min,
    // so LRU evicts oldest and the new entry takes its slot.
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    expect(registry.__sessionCount(ctx.participantId)).toBe(2);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'presence_session_evicted_lru',
        participantId: ctx.participantId,
      }),
      expect.any(String),
    );
  });

  it('LRU does NOT evict when oldest entry is below threshold — rejects with too_many_sessions', async () => {
    registry = createPresenceRegistry({
      maxSessionsPerParticipant: 2,
      idleTimeoutMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      lruEvictThresholdMs: 15 * 60 * 1000,
      now: clock,
    });
    const ctx = activeContext();

    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    advance(5 * 60 * 1000);
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
    advance(5 * 60 * 1000); // oldest is now 10 min idle, below 15 min threshold

    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) && err.code === 'INVALID_INPUT' && err.subCode === 'too_many_sessions',
    );
    expect(registry.__sessionCount(ctx.participantId)).toBe(2);
  });

  it('forEachSubscriber post-success refreshes lastSeenAt — active receiver is not evicted', async () => {
    registry = createPresenceRegistry({
      idleTimeoutMs: 10 * 60 * 1000,
      sweepIntervalMs: 60 * 1000,
      now: clock,
    });
    const ctx = activeContext();
    const handle = mockHandle(ctx);
    await registry.subscribe({ callerContext: ctx, handle });

    advance(8 * 60 * 1000); // 8 min — within window
    const fakeNotification: WaggleNotification = {
      kind: 'online',
      cellId: uuidv7(),
      recipientId: ctx.participantId,
      unreadCount: 1,
      senderIds: [],
      waggleId: uuidv7(),
      emittedAt: clock(),
    };
    await registry.forEachSubscriber(ctx.participantId, (h) => h.deliver(fakeNotification));

    advance(8 * 60 * 1000); // another 8 min — total 16 min since subscribe.
    // Without the post-success touch this would be evicted; with it the
    // lastSeenAt is fresh as of t=8min, so 8 min into the second window the
    // entry is still alive (16 - 8 = 8 min idle, within 10 min threshold).
    registry.__sweepStale(clock());

    expect(registry.__sessionCount(ctx.participantId)).toBe(1);
  });

  it('heartbeatTimeoutMs is honored as a deprecated alias for idleTimeoutMs (with warning)', async () => {
    const { logger, warn } = silentLogger();
    registry = createPresenceRegistry({
      heartbeatTimeoutMs: 10 * 60 * 1000,
      sweepIntervalMs: 60 * 1000,
      now: clock,
      logger,
    });
    const ctx = activeContext();
    await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    advance(11 * 60 * 1000);
    registry.__sweepStale(clock());

    expect(registry.__sessionCount(ctx.participantId)).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'presence_heartbeat_timeout_ms_deprecated' }),
      expect.any(String),
    );
  });

  it('regression INC-2026-003 — 16 stale subs + 17th succeeds via LRU evict', async () => {
    registry = createPresenceRegistry({
      maxSessionsPerParticipant: 16,
      idleTimeoutMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      lruEvictThresholdMs: 15 * 60 * 1000,
      now: clock,
    });
    const ctx = activeContext();

    // 16 subscribes that never DELETE /mcp and never trigger socket close —
    // simulates the production leak scenario (clients that crash or
    // disconnect without closing the SSE stream).
    for (let i = 0; i < 16; i++) {
      await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });
      advance(1_000); // each sub a second apart so lastSeenAt orders LRU
    }
    expect(registry.__sessionCount(ctx.participantId)).toBe(16);

    // The 17th subscribe pre-fix would reject with `too_many_sessions`. With
    // the fix, the LRU threshold (15 min) is met by the oldest (~16 sec
    // away) only after enough time passes — first verify rejection while all
    // are recent, then advance and verify success.
    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).rejects.toSatisfy(
      (err) =>
        isWaggleError(err) && err.code === 'INVALID_INPUT' && err.subCode === 'too_many_sessions',
    );

    // Advance 16 minutes — oldest is now ~16 min idle, threshold met.
    advance(16 * 60 * 1000);
    await expect(
      registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) }),
    ).resolves.toBeDefined();
    expect(registry.__sessionCount(ctx.participantId)).toBe(16);
  });

  it('race: sweep and explicit unsubscribe interleave without throwing', async () => {
    registry = createPresenceRegistry({
      idleTimeoutMs: 10 * 60 * 1000,
      sweepIntervalMs: 60 * 1000,
      now: clock,
    });
    const ctx = activeContext();
    const sub = await registry.subscribe({ callerContext: ctx, handle: mockHandle(ctx) });

    advance(11 * 60 * 1000);
    // Both sweep and explicit unsubscribe target the same entry. The second
    // call MUST be idempotent (no throw, no negative count).
    const reg = registry;
    reg.__sweepStale(clock());
    expect(() => reg.unsubscribe(sub.id, ctx.participantId)).not.toThrow();

    expect(reg.__sessionCount(ctx.participantId)).toBe(0);
  });

  it('sweep without idleTimeoutMs configured is a no-op via __sweepStale', () => {
    const reg = createPresenceRegistry({
      idleTimeoutMs: null,
      now: clock,
    });
    registry = reg;
    // Even calling sweep manually with stale snapshot does nothing.
    expect(() => reg.__sweepStale(new Date(nowMs + 1_000_000))).not.toThrow();
  });

  it('emits config_sweep_misconfigured warn when idleTimeoutMs > 0 but sweepIntervalMs <= 0 (closes PRY-017 N2)', () => {
    const { logger, warn } = silentLogger();
    registry = createPresenceRegistry({
      idleTimeoutMs: 30 * 60 * 1000,
      sweepIntervalMs: 0,
      now: clock,
      logger,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0]!;
    const fields = call[0] as Record<string, unknown>;
    expect(fields['event']).toBe('config_sweep_misconfigured');
    expect(fields['component']).toBe('PresenceRegistry');
    expect(fields['enabledMs']).toBe(30 * 60 * 1000);
    expect(fields['intervalMs']).toBe(0);
  });

  it('does NOT emit config_sweep_misconfigured warn when both idleTimeoutMs and sweepIntervalMs are positive', () => {
    const { logger, warn } = silentLogger();
    registry = createPresenceRegistry({
      idleTimeoutMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      now: clock,
      logger,
    });

    const misconfigCalls = warn.mock.calls.filter((c) => {
      const f = c[0] as Record<string, unknown> | undefined;
      return f?.['event'] === 'config_sweep_misconfigured';
    });
    expect(misconfigCalls.length).toBe(0);
  });

  it('does NOT emit config_sweep_misconfigured warn when idleTimeoutMs is null (sweep disabled)', () => {
    const { logger, warn } = silentLogger();
    registry = createPresenceRegistry({
      idleTimeoutMs: null,
      sweepIntervalMs: 0,
      now: clock,
      logger,
    });

    const misconfigCalls = warn.mock.calls.filter((c) => {
      const f = c[0] as Record<string, unknown> | undefined;
      return f?.['event'] === 'config_sweep_misconfigured';
    });
    expect(misconfigCalls.length).toBe(0);
  });
});
