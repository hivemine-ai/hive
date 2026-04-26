// Unit tests for the Presence Registry. The SubscriberHandle is mocked inline
// via `mockHandle()` (deliver captures into an array; onClose stores the
// callback for explicit triggering).

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

import type { SubscriberHandle } from './subscriber-handle.js';
import type { WaggleNotification } from '../waggle/types.js';
import { createPresenceRegistry } from './registry.js';
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
