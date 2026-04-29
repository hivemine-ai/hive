import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityContext } from '#domain/auth/types.js';
import type { WaggleNotification } from '#domain/notifications/waggle/types.js';

import type { McpServerNotifier } from './subscriber-handle.js';
import {
  buildChannelContent,
  buildChannelMeta,
  createMcpSubscriberHandle,
} from './subscriber-handle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeIdentity(): IdentityContext {
  return {
    participantId: '01966e10-0000-7000-8000-000000000001',
    kind: 'worker',
    hiveId: '01966e10-0000-7000-8000-000000000002',
    hiveName: 'test-hive',
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

function makeNotifier(): McpServerNotifier & {
  sendResourceUpdated: ReturnType<typeof vi.fn>;
  sendChannelNotification: ReturnType<typeof vi.fn>;
} {
  return {
    sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
    sendChannelNotification: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

function makeHandle(notifier: McpServerNotifier, identity?: IdentityContext, logger?: Logger) {
  const callerContext = identity ?? makeIdentity();
  return createMcpSubscriberHandle({
    callerContext,
    serverRef: new WeakRef(notifier),
    logger: logger ?? makeLogger(),
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
      logger: makeLogger(),
    });
    expect(handle.callerContext).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — deliver Emit 1 (resources/updated) happy path
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver Emit 1 (resources/updated)', () => {
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
    const arg = notifier.sendResourceUpdated.mock.calls[0]?.[0] as {
      uri: string;
    };
    expect(arg.uri).toBe('hive://cells/01966e10-0000-7000-8000-000000000010');
  });

  it('sends _meta.hiveWaggle with snake_case fields matching the notification (online)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const notification = makeNotification({ kind: 'online' });
    await handle.deliver(notification);
    const arg = notifier.sendResourceUpdated.mock.calls[0]?.[0] as {
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
    const arg = notifier.sendResourceUpdated.mock.calls[0]?.[0] as {
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
    const arg = notifier.sendResourceUpdated.mock.calls[0]?.[0] as {
      _meta: { hiveWaggle: { emitted_at: string } };
    };
    expect(arg._meta.hiveWaggle.emitted_at).toBe('2026-04-26T12:34:56.789Z');
  });
});

// ---------------------------------------------------------------------------
// Group 3 — deliver when server is gone (WeakRef deref undefined)
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver server gone', () => {
  it('throws when serverRef.deref() returns undefined', async () => {
    const fakeRef = {
      deref: vi.fn().mockReturnValue(undefined),
    } as unknown as WeakRef<McpServerNotifier>;
    const handle = createMcpSubscriberHandle({
      callerContext: makeIdentity(),
      serverRef: fakeRef,
      logger: makeLogger(),
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
      logger: makeLogger(),
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
      logger: makeLogger(),
    });
    const listener = vi.fn();
    handle.onClose(listener);
    await expect(handle.deliver(makeNotification())).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — deliver Emit 1 throws (transport error on resources/updated)
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver Emit 1 throws', () => {
  it('propagates the SDK rejection from sendResourceUpdated', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockRejectedValue(new Error('socket dead')),
      sendChannelNotification: vi.fn().mockResolvedValue(undefined),
    };
    const handle = makeHandle(notifier);
    await expect(handle.deliver(makeNotification())).rejects.toThrow('socket dead');
  });

  it('does not invoke sendChannelNotification if Emit 1 throws', async () => {
    const channelMock = vi.fn().mockResolvedValue(undefined);
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockRejectedValue(new Error('socket dead')),
      sendChannelNotification: channelMock,
    };
    const handle = makeHandle(notifier);
    await expect(handle.deliver(makeNotification())).rejects.toThrow('socket dead');
    expect(channelMock).not.toHaveBeenCalled();
  });

  it('fires _fireCloseListeners when Emit 1 rejects', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockRejectedValue(new Error('socket dead')),
      sendChannelNotification: vi.fn().mockResolvedValue(undefined),
    };
    const handle = makeHandle(notifier);
    const listener = vi.fn();
    handle.onClose(listener);
    await expect(handle.deliver(makeNotification())).rejects.toThrow('socket dead');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — deliver Emit 2 (claude/channel) happy path
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver Emit 2 (claude/channel) happy path', () => {
  it('calls sendChannelNotification exactly once per deliver', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    expect(notifier.sendChannelNotification).toHaveBeenCalledTimes(1);
  });

  it('emits exactly two notifications per deliver (one per envelope)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    expect(notifier.sendResourceUpdated).toHaveBeenCalledTimes(1);
    expect(notifier.sendChannelNotification).toHaveBeenCalledTimes(1);
  });

  it('passes content as a non-empty string', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(typeof arg.content).toBe('string');
    expect(arg.content.length).toBeGreaterThan(0);
  });

  it('passes meta as a flat Record<string, string> with the six required keys', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    const notification = makeNotification();
    await handle.deliver(notification);
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(arg.meta).toEqual({
      cell_id: notification.cellId,
      kind: notification.kind,
      unread_count: String(notification.unreadCount),
      sender_ids: notification.senderIds.join(','),
      waggle_id: notification.waggleId,
      emitted_at: notification.emittedAt.toISOString(),
    });
  });

  it('does not include params.channel (correctly absent per second amend)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      content: string;
      meta: Record<string, string>;
      channel?: unknown;
    };
    expect(arg).not.toHaveProperty('channel');
  });

  it('does not include recipient_id in meta (omitted per spec)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      meta: Record<string, string>;
    };
    expect(arg.meta).not.toHaveProperty('recipient_id');
  });

  it('all meta keys are identifier-only (letters, digits, underscores)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      meta: Record<string, string>;
    };
    const identifierRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(arg.meta)) {
      expect(key).toMatch(identifierRegex);
    }
  });

  it('all meta values are strings (no nested objects, arrays, or numbers)', async () => {
    const notifier = makeNotifier();
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    const arg = notifier.sendChannelNotification.mock.calls[0]?.[0] as {
      meta: Record<string, unknown>;
    };
    for (const value of Object.values(arg.meta)) {
      expect(typeof value).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Group 6 — deliver Emit 2 fails (fail-safe absorbs the error)
// ---------------------------------------------------------------------------

describe('McpSubscriberHandle — deliver Emit 2 fails (fail-safe)', () => {
  it('resolves successfully when sendChannelNotification rejects', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
      sendChannelNotification: vi.fn().mockRejectedValue(new Error('channel drift')),
    };
    const handle = makeHandle(notifier);
    await expect(handle.deliver(makeNotification())).resolves.toBeUndefined();
  });

  it('logs warn with event mcp_channel_emit_failed when Emit 2 rejects', async () => {
    const logger = makeLogger();
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
      sendChannelNotification: vi.fn().mockRejectedValue(new Error('channel drift')),
    };
    const handle = makeHandle(notifier, undefined, logger);
    await handle.deliver(makeNotification());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp_channel_emit_failed' }),
      expect.any(String),
    );
  });

  it('does not fire close listeners when only Emit 2 fails', async () => {
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
      sendChannelNotification: vi.fn().mockRejectedValue(new Error('channel drift')),
    };
    const handle = makeHandle(notifier);
    const listener = vi.fn();
    handle.onClose(listener);
    await handle.deliver(makeNotification());
    expect(listener).not.toHaveBeenCalled();
  });

  it('Emit 1 still completes successfully when Emit 2 fails', async () => {
    const sendResourceUpdated = vi.fn().mockResolvedValue(undefined);
    const notifier: McpServerNotifier = {
      sendResourceUpdated,
      sendChannelNotification: vi.fn().mockRejectedValue(new Error('channel drift')),
    };
    const handle = makeHandle(notifier);
    await handle.deliver(makeNotification());
    expect(sendResourceUpdated).toHaveBeenCalledTimes(1);
  });

  it('warn log includes cellId and waggleId for traceability', async () => {
    const logger = makeLogger();
    const notifier: McpServerNotifier = {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
      sendChannelNotification: vi.fn().mockRejectedValue(new Error('channel drift')),
    };
    const handle = makeHandle(notifier, undefined, logger);
    const notification = makeNotification();
    await handle.deliver(notification);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_channel_emit_failed',
        cellId: notification.cellId,
        waggleId: notification.waggleId,
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Group 7 — onClose + _fireCloseListeners
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
    const logger = makeLogger();
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
    const logger = makeLogger();
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

// ---------------------------------------------------------------------------
// Group 8 — buildChannelContent (pure function)
// ---------------------------------------------------------------------------

describe('buildChannelContent', () => {
  it('uses singular "message" when unreadCount === 1', () => {
    const content = buildChannelContent(makeNotification({ unreadCount: 1 }));
    // "1 unread message in your mailbox" — singular noun before "in your mailbox".
    // Note: the actionable instruction "Run check_unread_messages" still has the
    // plural in the tool name regardless of count — that is a fixed tool identifier.
    expect(content).toContain('1 unread message in your mailbox');
    expect(content).not.toContain('1 unread messages');
  });

  it('uses plural "messages" when unreadCount > 1', () => {
    const content = buildChannelContent(makeNotification({ unreadCount: 5 }));
    expect(content).toContain('5 unread messages ');
  });

  it('uses plural "messages" when unreadCount === 0 (edge case, replay without unread)', () => {
    const content = buildChannelContent(makeNotification({ unreadCount: 0 }));
    expect(content).toContain('0 unread messages ');
  });

  it('includes the actionable instruction "Run check_unread_messages to read."', () => {
    const content = buildChannelContent(makeNotification());
    expect(content).toContain('Run check_unread_messages to read.');
  });

  it('appends an HTML comment with kind, waggle_id, and emitted_at for traceability', () => {
    const notification = makeNotification({
      kind: 'online',
      waggleId: '01966e10-0000-7000-8000-000000000099',
      emittedAt: new Date('2026-04-27T12:00:00.000Z'),
    });
    const content = buildChannelContent(notification);
    expect(content).toContain(
      '<!-- waggle: kind=online, waggle_id=01966e10-0000-7000-8000-000000000099, emitted_at=2026-04-27T12:00:00.000Z -->',
    );
  });

  it('separates prose and HTML comment with a blank line', () => {
    const content = buildChannelContent(makeNotification());
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain('You have');
    expect(lines[1]).toBe('');
    expect(lines.at(-1)).toMatch(/^<!-- waggle: /);
  });

  it('reflects kind=replay in the HTML comment', () => {
    const content = buildChannelContent(makeNotification({ kind: 'replay' }));
    expect(content).toContain('kind=replay');
  });
});

// ---------------------------------------------------------------------------
// Group 9 — buildChannelMeta (pure function)
// ---------------------------------------------------------------------------

describe('buildChannelMeta', () => {
  it('produces exactly the six required keys', () => {
    const meta = buildChannelMeta(makeNotification());
    expect(Object.keys(meta).sort()).toEqual(
      ['cell_id', 'emitted_at', 'kind', 'sender_ids', 'unread_count', 'waggle_id'].sort(),
    );
  });

  it('coerces unread_count number to string', () => {
    const meta = buildChannelMeta(makeNotification({ unreadCount: 42 }));
    expect(meta.unread_count).toBe('42');
    expect(typeof meta.unread_count).toBe('string');
  });

  it('joins senderIds array as CSV string', () => {
    const senderIds = [
      '01966e10-0000-7000-8000-000000000020',
      '01966e10-0000-7000-8000-000000000021',
      '01966e10-0000-7000-8000-000000000022',
    ];
    const meta = buildChannelMeta(makeNotification({ senderIds }));
    expect(meta.sender_ids).toBe(senderIds.join(','));
  });

  it('emits empty string for sender_ids when the array is empty', () => {
    const meta = buildChannelMeta(makeNotification({ senderIds: [] }));
    expect(meta.sender_ids).toBe('');
  });

  it('coerces emittedAt Date to ISO 8601 string', () => {
    const emittedAt = new Date('2026-04-27T12:34:56.789Z');
    const meta = buildChannelMeta(makeNotification({ emittedAt }));
    expect(meta.emitted_at).toBe('2026-04-27T12:34:56.789Z');
  });

  it('passes through cellId, kind, and waggleId verbatim', () => {
    const notification = makeNotification({
      cellId: '01966e10-0000-7000-8000-000000000010',
      kind: 'replay',
      waggleId: '01966e10-0000-7000-8000-000000000013',
    });
    const meta = buildChannelMeta(notification);
    expect(meta.cell_id).toBe('01966e10-0000-7000-8000-000000000010');
    expect(meta.kind).toBe('replay');
    expect(meta.waggle_id).toBe('01966e10-0000-7000-8000-000000000013');
  });

  it('all values are strings (Record<string, string> contract)', () => {
    const meta = buildChannelMeta(makeNotification());
    for (const value of Object.values(meta)) {
      expect(typeof value).toBe('string');
    }
  });
});
