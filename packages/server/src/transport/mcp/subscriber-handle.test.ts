import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityContext } from '#domain/auth/types.js';
import type { WaggleNotification } from '#domain/notifications/waggle/types.js';

import type { McpServerNotifier } from './subscriber-handle.js';
import { createMcpSubscriberHandle } from './subscriber-handle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeIdentity(): IdentityContext {
  return {
    participantId: '01966e10-0000-7000-8000-000000000001',
    kind: 'worker',
    hiveId: '01966e10-0000-7000-8000-000000000002',
    colonyId: '01966e10-0000-7000-8000-000000000003',
    snapshot: {
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      credentialJti: '01966e10-0000-7000-8000-000000000004',
      credentialKid: 'kid-001',
    },
    current: { state: 'active' },
  };
}

function makeNotification(overrides: Partial<WaggleNotification> = {}): WaggleNotification {
  return {
    kind: 'online',
    cellId: '01966e10-0000-7000-8000-000000000010',
    recipientId: '01966e10-0000-7000-8000-000000000011',
    unreadCount: 3,
    senderIds: ['01966e10-0000-7000-8000-000000000012'],
    emittedAt: new Date('2026-04-26T12:00:00.000Z'),
    waggleId: '01966e10-0000-7000-8000-000000000013',
    ...overrides,
  };
}

function makeNotifier(): McpServerNotifier & { sendResourceUpdated: ReturnType<typeof vi.fn> } {
  return { sendResourceUpdated: vi.fn().mockResolvedValue(undefined) };
}

function makeHandle(notifier: McpServerNotifier, identity?: IdentityContext) {
  const callerContext = identity ?? makeIdentity();
  return createMcpSubscriberHandle({
    callerContext,
    serverRef: new WeakRef(notifier),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger,
  });
}

// ---------------------------------------------------------------------------
// Group 1 — connectionId
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — connectionId', () => {
  it('conforms to UUID v7 regex', () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    expect(handle.connectionId).toMatch(UUID_V7_REGEX);
  });

  it('generates distinct connectionIds for each instance', () => {
    const notifier = makeNotifier();
    const a = makeHandle(notifier);
    const b = makeHandle(notifier);
    expect(a.connectionId).not.toBe(b.connectionId);
  });

  it('exposes callerContext as the same reference passed in', () => {
    const notifier = makeNotifier();
    const identity = makeIdentity();
    const handle = createMcpSubscriberHandle({
      callerContext: identity,
      serverRef: new WeakRef(notifier),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      } as unknown as Logger,
    });
    expect(handle.callerContext).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — deliver happy path
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver happy path', () => {
  it('calls sendResourceUpdated exactly once per deliver', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    expect(notifier.sendResourceUpdated).toHaveBeenCalledTimes(1);
  });

  it('sends the correct URI for the cell', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const notification = makeNotification({ cellId: '01966e10-0000-7000-8000-000000000010' });
    await handle.deliver(notification);
    const arg = (notifier.sendResourceUpdated as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      uri: string;
    };
    expect(arg.uri).toBe('hive://cells/01966e10-0000-7000-8000-000000000010');
  });

  it('sends _meta.hiveWaggle with snake_case fields matching the notification (online)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const notification = makeNotification({ kind: 'online' });
    await handle.deliver(notification);
    const arg = (notifier.sendResourceUpdated as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      uri: string;
      _meta: { hiveWaggle: Record<string, unknown> };
    };
    expect(arg._meta.hiveWaggle).toEqual({
      kind: 'online',
      recipient_id: notification.recipientId,
      unread_count: notification.unreadCount,
      sender_ids: notification.senderIds,
      emitted_at: notification.emittedAt.toISOString(),
      waggle_id: notification.waggleId,
    });
  });

  it('sends _meta.hiveWaggle with snake_case fields matching the notification (replay)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const notification = makeNotification({ kind: 'replay' });
    await handle.deliver(notification);
    const arg = (notifier.sendResourceUpdated as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      uri: string;
      _meta: { hiveWaggle: Record<string, unknown> };
    };
    expect(arg._meta.hiveWaggle.kind).toBe('replay');
  });

  it('converts emittedAt Date to ISO 8601 string', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const emittedAt = new Date('2026-04-26T12:34:56.789Z');
    await handle.deliver(makeNotification({ emittedAt }));
    const arg = (notifier.sendResourceUpdated as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      _meta: { hiveWaggle: { emitted_at: string } };
    };
    expect(arg._meta.hiveWaggle.emitted_at).toBe('2026-04-26T12:34:56.789Z');
  });
});

// ---------------------------------------------------------------------------
// Group 3 — deliver when server is gone
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver server gone', () => {
  it('throws when serverRef.deref() returns undefined', async () => {
    // Construct with a WeakRef stand-in whose deref() always returns undefined.
    const fakeRef = {
      deref: vi.fn().mockReturnValue(undefined),
    } as unknown as WeakRef<McpServerNotifier>;
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: fakeRef,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      } as unknown as Logger,
    });
    await expect(handle.deliver(makeNotification())).rejects.toThrow('server gone');
  });

  it('error message is exactly "McpSubscriberHandle: server gone"', async () => {
    const fakeRef = {
      deref: vi.fn().mockReturnValue(undefined),
    } as unknown as WeakRef<McpServerNotifier>;
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: fakeRef,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      } as unknown as Logger,
    });
    await expect(handle.deliver(makeNotification())).rejects.toThrow(
      'McpSubscriberHandle: server gone',
    );
  });

  it('fires _fireCloseListeners before throwing when server is gone', async () => {
    const fakeRef = {
      deref: vi.fn().mockReturnValue(undefined),
    } as unknown as WeakRef<McpServerNotifier>;
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: fakeRef,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      } as unknown as Logger,
    });
    const listener = vi.fn();
    handle.onClose(listener);
    await expect(handle.deliver(makeNotification())).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — deliver when SDK throws
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver SDK throws', () => {
  it('propagates the SDK rejection', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockRejectedValue(new Error('socket dead')),
    };
    const handle = makeHandle(notifier);
    await expect(handle.deliver(makeNotification())).rejects.toThrow('socket dead');
  });

  it('fires _fireCloseListeners when the SDK rejects', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockRejectedValue(new Error('socket dead')),
    };
    const handle = makeHandle(notifier);
    const listener = vi.fn();
    handle.onClose(listener);
    await expect(handle.deliver(makeNotification())).rejects.toThrow('socket dead');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — onClose + _fireCloseListeners
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — onClose + _fireCloseListeners', () => {
  it('invokes all registered listeners in registration order', () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const calls: number[] = [];
    handle.onClose(() => calls.push(1));
    handle.onClose(() => calls.push(2));
    handle.onClose(() => calls.push(3));
    handle._fireCloseListeners();
    expect(calls).toEqual([1, 2, 3]);
  });

  it('a throwing listener does not prevent subsequent listeners from running', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;
    const notifier = makeNotifier();
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: new WeakRef(notifier),
      logger,
    });
    const ok1 = vi.fn();
    const throwing = vi.fn().mockImplementation(() => {
      throw new Error('listener error');
    });
    const ok2 = vi.fn();
    handle.onClose(ok1);
    handle.onClose(throwing);
    handle.onClose(ok2);
    expect(() => handle._fireCloseListeners()).not.toThrow();
    expect(ok1).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(ok2).toHaveBeenCalledTimes(1);
  });

  it('logs via logger.warn when a listener throws', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;
    const notifier = makeNotifier();
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: new WeakRef(notifier),
      logger,
    });
    handle.onClose(() => {
      throw new Error('listener error');
    });
    handle._fireCloseListeners();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'subscriber_handle_onclose_listener_failed' }),
    );
  });

  it('empties the listeners array after firing (second call is a no-op)', () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const listener = vi.fn();
    handle.onClose(listener);
    handle._fireCloseListeners();
    handle._fireCloseListeners();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts new listeners after a fire (for next batch)', () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const first = vi.fn();
    handle.onClose(first);
    handle._fireCloseListeners();
    const second = vi.fn();
    handle.onClose(second);
    handle._fireCloseListeners();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
