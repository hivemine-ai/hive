import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityContext } from '#domain/auth/index.js';
import type { StreamCloseReason, WaggleNotification } from '#domain/notifications/index.js';
import { createLogger } from '#observability/logger.js';
import type { Logger } from '#observability/logger.js';

import { createStreamHandle, toEnvelope, type ListenSink } from './subscriber-handle.js';

const KEEPALIVE_MS = 1000;
const STALL_MS = 3000;
const SUBSCRIPTION_META = 'io.modelcontextprotocol/subscriptionId';

class FakeSink extends EventEmitter implements ListenSink {
  frames: string[] = [];
  pendingCallbacks: Array<(err?: Error | null) => void> = [];
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  /** When false, write callbacks stay pending, as with a socket that does not drain. */
  autoFlush = true;
  failWith: Error | undefined;

  write(chunk: string, callback: (err?: Error | null) => void): boolean {
    this.frames.push(chunk);
    if (this.failWith) {
      callback(this.failWith);
      return false;
    }
    if (this.autoFlush) {
      callback();
      return true;
    }
    this.writableLength += chunk.length;
    this.pendingCallbacks.push(callback);
    return false;
  }

  flush(): void {
    this.writableLength = 0;
    for (const callback of this.pendingCallbacks.splice(0)) callback();
    this.emit('drain');
  }

  destroy(): void {
    this.destroyed = true;
  }

  messages(): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.startsWith('event: message'))
      .map((f) => JSON.parse(f.split('data: ')[1] ?? '') as Record<string, unknown>);
  }
}

const NOTIFICATION: WaggleNotification = {
  kind: 'online',
  eventId: 'a'.repeat(64),
  cellId: '01900000-0000-7000-8000-00000000000c',
  recipientId: '01900000-0000-7000-8000-00000000000b',
  unreadCount: 2,
  coalescedCount: 7,
  senderIds: ['01900000-0000-7000-8000-00000000000a'],
  emittedAt: new Date('2026-11-02T10:00:00.000Z'),
  waggleId: '01900000-0000-7000-8000-0000000000dd',
};

function identity(credentialExpiresAt?: Date): IdentityContext {
  return {
    participantId: NOTIFICATION.recipientId,
    snapshot: { ...(credentialExpiresAt && { credentialExpiresAt }) },
  } as unknown as IdentityContext;
}

function build(
  options: { expiresAt?: Date; logger?: Logger; keepAliveMs?: number; leaseMs?: number } = {},
) {
  const sink = new FakeSink();
  const abort = vi.fn();
  const handle = createStreamHandle({
    callerContext: identity(options.expiresAt),
    sink,
    subscriptionId: 7,
    serverInfo: { name: 'hive', version: '1' },
    abort,
    keepAliveIntervalMs: options.keepAliveMs ?? KEEPALIVE_MS,
    stallTimeoutMs: STALL_MS,
    logger: options.logger ?? createLogger({ level: 'silent' }),
    ...(options.leaseMs !== undefined && { leaseMs: options.leaseMs }),
  });
  const closes: StreamCloseReason[] = [];
  handle.onClose((reason) => closes.push(reason));
  return { sink, handle, abort, closes };
}

describe('toEnvelope', () => {
  it('carries only the wire fields, in snake_case, with the subscription id', () => {
    const envelope = toEnvelope(NOTIFICATION, 7) as {
      method: string;
      params: { uri: string; _meta: Record<string, unknown> };
    };

    expect(envelope.method).toBe('notifications/resources/updated');
    expect(envelope.params.uri).toBe(`hive://cells/${NOTIFICATION.cellId}`);
    expect(envelope.params._meta[SUBSCRIPTION_META]).toBe(7);
    expect(envelope.params._meta['hiveWaggle']).toEqual({
      kind: 'online',
      recipient_id: NOTIFICATION.recipientId,
      unread_count: 2,
      sender_ids: NOTIFICATION.senderIds,
      emitted_at: '2026-11-02T10:00:00.000Z',
      waggle_id: NOTIFICATION.waggleId,
      event_id: NOTIFICATION.eventId,
    });
  });

  it('never lets a body, a cursor or the coalesced count through', () => {
    const raw = JSON.stringify(
      toEnvelope({ ...NOTIFICATION, body: 'secret', cursor: 'c' } as WaggleNotification, 1),
    );
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('cursor');
    expect(raw).not.toContain('coalesced');
  });
});

describe('createStreamHandle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('deliver', () => {
    it('writes exactly one Envelope 1 frame in the SSE shape of the SDK router', async () => {
      const { sink, handle } = build();
      await handle.deliver(NOTIFICATION);

      expect(sink.frames).toHaveLength(1);
      expect(sink.frames[0]).toMatch(/^event: message\ndata: \{.*\}\n\n$/);
      expect(sink.messages()[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
      });
      handle.close('client_closed');
    });

    it('a failed write rejects after the handle closed itself with write_failed', async () => {
      const { sink, handle, closes } = build();
      sink.failWith = new Error('EPIPE');

      await expect(handle.deliver(NOTIFICATION)).rejects.toThrow('EPIPE');

      expect(closes).toEqual(['write_failed']);
      expect(sink.destroyed).toBe(true);
    });

    it('rejects once closed, and a pending deliver rejects on close', async () => {
      const { sink, handle } = build();
      sink.autoFlush = false;
      const pending = handle.deliver(NOTIFICATION);
      handle.close('participant_suspended');

      await expect(pending).rejects.toThrow('stream closed');
      await expect(handle.deliver(NOTIFICATION)).rejects.toThrow('stream closed');
    });
  });

  describe('keep-alive and detector', () => {
    it('writes a keep-alive comment on an idle stream', async () => {
      const { sink, handle } = build();
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
      expect(sink.frames).toEqual(Array<string>(3).fill(': keepalive\n\n'));
      handle.close('client_closed');
    });

    it('a failed keep-alive write closes with write_failed', async () => {
      const { sink, closes } = build();
      sink.failWith = new Error('ECONNRESET');
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      expect(closes).toEqual(['write_failed']);
    });

    it('closes with stalled when written bytes do not drain in time', async () => {
      const warn = vi.fn();
      const logger = {
        warn,
        info: () => undefined,
        debug: () => undefined,
      } as unknown as Logger;
      const { sink, closes } = build({ logger });
      sink.autoFlush = false;

      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      await vi.advanceTimersByTimeAsync(STALL_MS - 1);
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(closes).toEqual(['stalled']);
      expect(sink.destroyed).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'mcp_listen_network_cut_detected', silenceMs: STALL_MS }),
        expect.any(String),
      );
    });

    it('a stream that drains in time never stalls, however slow', async () => {
      const { sink, handle, closes } = build();
      sink.autoFlush = false;
      for (let i = 0; i < 20; i += 1) {
        await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
        sink.flush();
      }
      expect(closes).toEqual([]);
      handle.close('client_closed');
    });

    it('a drain with bytes still pending restarts the clock', async () => {
      const { sink, handle, closes } = build();
      sink.autoFlush = false;
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
      await vi.advanceTimersByTimeAsync(STALL_MS - 100);
      sink.emit('drain');
      await vi.advanceTimersByTimeAsync(STALL_MS - 1);
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes).toEqual(['stalled']);
      handle.close('client_closed');
    });

    it('a stream with nothing pending has no clock running', async () => {
      const { handle, closes } = build();
      await vi.advanceTimersByTimeAsync(STALL_MS * 10);
      expect(closes).toEqual([]);
      handle.close('client_closed');
    });
  });

  describe('close', () => {
    it.each(['evicted_lru', 'shutdown', 'lease_expired'] as const)(
      '%s ends with the complete result',
      (reason) => {
        const { sink, handle, abort, closes } = build();

        handle.close(reason);

        expect(sink.messages()).toEqual([
          {
            jsonrpc: '2.0',
            id: 7,
            result: {
              resultType: 'complete',
              _meta: {
                [SUBSCRIPTION_META]: 7,
                'io.modelcontextprotocol/serverInfo': { name: 'hive', version: '1' },
              },
            },
          },
        ]);
        expect(abort).toHaveBeenCalledOnce();
        expect(sink.destroyed).toBe(false);
        expect(closes).toEqual([reason]);
      },
    );

    it('a complete that cannot leave is torn down after the grace', async () => {
      const { sink, handle } = build();
      handle.close('shutdown');
      await vi.advanceTimersByTimeAsync(1000);
      expect(sink.destroyed).toBe(true);
    });

    it.each([
      'participant_revoked',
      'participant_suspended',
      'credential_expired',
      'replay_failed',
    ] as const)('%s cuts the stream without complete', (reason) => {
      const { sink, handle, abort, closes } = build();

      handle.close(reason);

      expect(sink.messages()).toEqual([]);
      expect(sink.destroyed).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
      expect(closes).toEqual([reason]);
    });

    it('fires onClose once, for whatever ends first', () => {
      const { sink, handle, closes } = build();
      handle.close('shutdown');
      handle.close('participant_revoked');
      sink.emit('close');
      expect(closes).toEqual(['shutdown']);
    });

    it('the response closing is client_closed', () => {
      const { sink, closes } = build();
      sink.emit('close');
      expect(closes).toEqual(['client_closed']);
    });

    it('a response error is write_failed', () => {
      const { sink, closes } = build();
      sink.emit('error', new Error('EPIPE'));
      expect(closes).toEqual(['write_failed']);
    });

    it('a callback registered on a closed handle fires at once with the same reason', () => {
      const { handle } = build();
      handle.close('evicted_lru');
      const late = vi.fn();
      handle.onClose(late);
      expect(late).toHaveBeenCalledWith('evicted_lru');
    });

    it('a throwing listener does not stop the others', () => {
      const { handle, closes } = build();
      const second = vi.fn();
      handle.onClose(() => {
        throw new Error('boom');
      });
      handle.onClose(second);
      handle.close('client_closed');
      expect(closes).toEqual(['client_closed']);
      expect(second).toHaveBeenCalledOnce();
    });

    it('stops writing keep-alives after closing', async () => {
      const { sink, handle } = build();
      handle.close('participant_revoked');
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
      expect(sink.frames).toEqual([]);
    });
  });

  describe('lease', () => {
    const LEASE_MS = 600;

    it('without a lease the stream never expires, however long it stays quiet', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const { handle, closes } = build({ keepAliveMs: dayMs });
      await vi.advanceTimersByTimeAsync(30 * dayMs);
      expect(closes).toEqual([]);
      expect(handle.renewLease()).toBe(false);
      handle.close('client_closed');
    });

    it('expires after the lease with lease_expired, ending with complete', async () => {
      const { sink, closes, abort } = build({ leaseMs: LEASE_MS });

      await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(closes).toEqual(['lease_expired']);
      const [complete] = sink.messages() as Array<{ id?: unknown; result?: unknown }>;
      expect(sink.messages()).toHaveLength(1);
      expect(complete?.id).toBe(7);
      expect(complete?.result).toMatchObject({ resultType: 'complete' });
      expect(abort).toHaveBeenCalledOnce();
    });

    it('a complete that cannot leave a dead path is torn down after the grace', async () => {
      const { sink } = build({ leaseMs: LEASE_MS });
      await vi.advanceTimersByTimeAsync(LEASE_MS);
      expect(sink.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sink.destroyed).toBe(true);
    });

    it('every renewal restarts the full lease', async () => {
      const { handle, closes } = build({ leaseMs: LEASE_MS });
      for (let beat = 0; beat < 10; beat += 1) {
        await vi.advanceTimersByTimeAsync(LEASE_MS - 100);
        expect(handle.renewLease()).toBe(true);
      }
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(LEASE_MS);
      expect(closes).toEqual(['lease_expired']);
    });

    it('keep-alives and deliveries do not renew it: only the client can', async () => {
      const { handle, closes } = build({ leaseMs: LEASE_MS, keepAliveMs: 100 });
      await vi.advanceTimersByTimeAsync(LEASE_MS / 2);
      await handle.deliver(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(LEASE_MS / 2);
      expect(closes).toEqual(['lease_expired']);
    });

    it('logs mcp_listen_lease_expired with the lease length', async () => {
      const entries: Array<Record<string, unknown>> = [];
      const push = (payload: Record<string, unknown>): void => {
        entries.push(payload);
      };
      const logger = { info: push, warn: push, error: push, debug: push } as unknown as Logger;
      build({ leaseMs: LEASE_MS, logger });

      await vi.advanceTimersByTimeAsync(LEASE_MS);

      expect(entries).toContainEqual(
        expect.objectContaining({
          event: 'mcp_listen_lease_expired',
          participantId: NOTIFICATION.recipientId,
          leaseMs: LEASE_MS,
        }),
      );
      expect(
        entries.find((e) => e['event'] === 'mcp_listen_lease_expired')?.['connectionId'],
      ).toEqual(expect.any(String));
    });

    it('a closed handle cannot be renewed and its lease timer is gone', async () => {
      const { handle, closes } = build({ leaseMs: LEASE_MS });
      handle.close('client_closed');
      expect(handle.renewLease()).toBe(false);
      await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
      expect(closes).toEqual(['client_closed']);
    });
  });

  describe('credential expiry', () => {
    it('closes at the expiry with credential_expired', async () => {
      const { closes } = build({ expiresAt: new Date(Date.now() + 5000) });
      await vi.advanceTimersByTimeAsync(4999);
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes).toEqual(['credential_expired']);
    });

    it('survives a TTL past the 32-bit timer limit, re-arming in legs', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const { handle, closes } = build({
        expiresAt: new Date(Date.now() + 40 * dayMs),
        keepAliveMs: 10 * dayMs,
      });

      await vi.advanceTimersByTimeAsync(39 * dayMs);
      expect(closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(dayMs);
      expect(closes).toEqual(['credential_expired']);
      handle.close('client_closed');
    });

    it('an already expired credential closes right away', () => {
      const { closes } = build({ expiresAt: new Date(Date.now() - 1) });
      // onClose was registered after construction, so it fires on registration.
      expect(closes).toEqual(['credential_expired']);
    });
  });
});
