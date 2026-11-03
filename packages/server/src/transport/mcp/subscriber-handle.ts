// `SubscriberHandle` over one `subscriptions/listen` stream. One handle = one stream.
//
// The SDK router owns the acknowledgment and nothing else here: events, keep-alives and
// the final `complete` are written straight to the HTTP response, for two reasons. The
// SDK bus broadcasts to every stream of a URI, and a replay belongs to a single stream.
// And only the response exposes what the detector needs, the write callback and the
// bytes still undrained. Frames match the router's, so a client cannot tell them apart.
//
// A dead path shows up in two ways: a failed write (`write_failed`), or bytes that stop
// draining (`stalled`). Nothing here can see a silent partition while the kernel still
// accepts the bytes; that one ends when TCP gives up.

import { SERVER_INFO_META_KEY, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/server';
import { v7 as uuidv7 } from 'uuid';

import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
import type {
  StreamCloseReason,
  SubscriberHandle,
  WaggleNotification,
} from '#domain/notifications/index.js';
import type { Logger } from '#observability/logger.js';

import { mailboxUri } from './resources.js';

/** The part of the HTTP response a stream needs. */
export interface ListenSink {
  write(chunk: string, callback: (err?: Error | null) => void): boolean;
  destroy(): unknown;
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
}

export interface StreamHandleDeps {
  callerContext: IdentityContext;
  sink: ListenSink;
  /** JSON-RPC id of the listen request: the SDK uses it as the subscription id. */
  subscriptionId: string | number;
  serverInfo: { name: string; version: string };
  /** Ends the SDK side of the stream. */
  abort: () => void;
  keepAliveIntervalMs: number;
  stallTimeoutMs: number;
  logger: Logger;
}

/** Forced closes the client must see as a clean end, so it reconnects. */
const COMPLETE_REASONS: ReadonlySet<StreamCloseReason> = new Set(['evicted_lru', 'shutdown']);

/** Grace for the `complete` frame to leave before the socket is torn down anyway. */
const COMPLETE_FLUSH_MS = 1000;

/** A Node timer overflows past 2^31-1 ms and fires at once, so long waits go in legs. */
const MAX_EXPIRY_LEG_MS = 24 * 60 * 60 * 1000;

function sseFrame(message: object): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** Envelope 1. Only validated metadata: `coalescedCount` and bodies never reach the wire. */
export function toEnvelope(
  notification: WaggleNotification,
  subscriptionId: string | number,
): object {
  return {
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: {
      uri: mailboxUri(notification.cellId),
      _meta: {
        hiveWaggle: {
          kind: notification.kind,
          recipient_id: notification.recipientId,
          unread_count: notification.unreadCount,
          sender_ids: notification.senderIds,
          emitted_at: notification.emittedAt.toISOString(),
          waggle_id: notification.waggleId,
          event_id: notification.eventId,
        },
        [SUBSCRIPTION_ID_META_KEY]: subscriptionId,
      },
    },
  };
}

export function createStreamHandle(deps: StreamHandleDeps): SubscriberHandle {
  const { callerContext, sink, subscriptionId, logger } = deps;
  const connectionId: UUIDv7 = uuidv7();
  const closeListeners: Array<(reason: StreamCloseReason) => void> = [];
  const pendingRejects = new Set<(err: Error) => void>();

  let closeReason: StreamCloseReason | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;

  function cancelStall(): void {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  }

  function startStall(): void {
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      if (sink.writableLength === 0) return;
      logger.warn(
        {
          event: 'mcp_listen_network_cut_detected',
          connectionId,
          participantId: callerContext.participantId,
          silenceMs: deps.stallTimeoutMs,
        },
        'stream stopped draining',
      );
      terminate('stalled');
    }, deps.stallTimeoutMs);
    stallTimer.unref();
  }

  function onDrain(): void {
    cancelStall();
    if (sink.writableLength > 0) startStall();
  }

  function onSinkClose(): void {
    clearTimeout(flushTimer);
    terminate('client_closed');
  }

  function onSinkError(): void {
    terminate('write_failed');
  }

  function release(): void {
    clearInterval(keepAliveTimer);
    clearTimeout(expiryTimer);
    cancelStall();
    sink.off('drain', onDrain);
    const err = new Error('stream closed');
    for (const reject of pendingRejects) reject(err);
    pendingRejects.clear();
  }

  function fireCloseListeners(reason: StreamCloseReason): void {
    for (const callback of closeListeners.splice(0)) {
      try {
        callback(reason);
      } catch (err) {
        logger.warn({
          event: 'subscriber_handle_onclose_listener_failed',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function terminate(reason: StreamCloseReason): void {
    if (closeReason !== undefined) return;
    closeReason = reason;
    release();
    if (COMPLETE_REASONS.has(reason)) {
      endWithComplete();
    } else {
      deps.abort();
      if (!sink.destroyed) sink.destroy();
    }
    fireCloseListeners(reason);
  }

  // Written while the SDK side is still attached: the abort that follows makes the pipe
  // end the response right after this frame.
  function endWithComplete(): void {
    if (!sink.destroyed && !sink.writableEnded) {
      sink.write(
        sseFrame({
          jsonrpc: '2.0',
          id: subscriptionId,
          result: {
            resultType: 'complete',
            _meta: {
              [SUBSCRIPTION_ID_META_KEY]: subscriptionId,
              [SERVER_INFO_META_KEY]: deps.serverInfo,
            },
          },
        }),
        () => undefined,
      );
    }
    deps.abort();
    flushTimer = setTimeout(() => {
      sink.destroy();
    }, COMPLETE_FLUSH_MS);
    flushTimer.unref();
  }

  function write(frame: string, settle: (err?: Error) => void): void {
    if (closeReason !== undefined || sink.destroyed || sink.writableEnded) {
      settle(new Error('stream closed'));
      return;
    }
    const onWritten = (err?: Error | null): void => {
      if (err) {
        settle(err);
        terminate('write_failed');
        return;
      }
      if (sink.writableLength === 0) cancelStall();
      settle();
    };
    try {
      sink.write(frame, onWritten);
    } catch (err) {
      onWritten(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (stallTimer === undefined && sink.writableLength > 0) startStall();
  }

  function armExpiry(expiresAt: Date): void {
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      terminate('credential_expired');
      return;
    }
    expiryTimer = setTimeout(
      () => {
        armExpiry(expiresAt);
      },
      Math.min(remaining, MAX_EXPIRY_LEG_MS),
    );
    expiryTimer.unref();
  }

  sink.on('drain', onDrain);
  sink.on('close', onSinkClose);
  sink.on('error', onSinkError);

  const keepAliveTimer = setInterval(() => {
    write(': keepalive\n\n', () => undefined);
  }, deps.keepAliveIntervalMs);
  keepAliveTimer.unref();

  const expiresAt = callerContext.snapshot.credentialExpiresAt;
  if (expiresAt !== undefined) armExpiry(expiresAt);

  return {
    connectionId,
    callerContext,

    deliver(notification) {
      return new Promise<void>((resolve, reject) => {
        pendingRejects.add(reject);
        write(sseFrame(toEnvelope(notification, subscriptionId)), (err) => {
          pendingRejects.delete(reject);
          if (err) reject(err);
          else resolve();
        });
      });
    },

    close(reason) {
      terminate(reason);
    },

    onClose(callback) {
      if (closeReason !== undefined) {
        callback(closeReason);
        return;
      }
      closeListeners.push(callback);
    },
  };
}
