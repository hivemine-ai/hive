import { v7 as uuidv7 } from 'uuid';
import type { Logger } from 'pino';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import type { WaggleNotification } from '#domain/notifications/waggle/types.js';

import type { SubscriberHandle } from '#domain/notifications/presence/subscriber-handle.js';

/**
 * Minimal subset of the MCP SDK's `Server` that we depend on. Lets us mock the
 * SDK in tests and keeps the handle decoupled from the SDK class hierarchy.
 */
export interface McpServerNotifier {
  sendResourceUpdated(params: { uri: string; _meta?: Record<string, unknown> }): Promise<void>;
}

export interface McpSubscriberHandleDeps {
  /** Identity captured at session-accept time. Inmutable. */
  callerContext: IdentityContext;
  /**
   * WeakRef to the MCP Server (or any structural McpServerNotifier).
   *
   * Why WeakRef: a bug or shutdown can leave the handle alive after the SDK
   * server is GC'd. `serverRef.deref()` returning undefined is the signal to
   * fire onClose listeners (auto-deregister from the registry) and surface a
   * deliver failure.
   */
  serverRef: WeakRef<McpServerNotifier>;
  logger: Logger;
}

export interface McpSubscriberHandle extends SubscriberHandle {
  /** Test-visible accessor; production code never reads it. */
  _fireCloseListeners(): void;
}

/**
 * Concrete handle implementing `SubscriberHandle` for an MCP session.
 *
 * Lifecycle:
 *   - `deliver(notification)` is invoked by the Waggle pipeline (online or
 *     replay). It maps the WaggleNotification to a `notifications/resources/updated`
 *     wire event with payload in `_meta.hiveWaggle` per the tech spec.
 *   - `onClose(callback)` is wired by the registry on `subscribe`. The
 *     callback is the closure that performs the registry's `unsubscribe`.
 *   - `_fireCloseListeners()` is invoked by the transport (http-host) when it
 *     detects the underlying socket close. Iterates all listeners with per-
 *     listener try/catch so one failing listener does not prevent the others.
 *     After firing, the listeners array is emptied (single-fire semantics).
 *
 * Note: if the transport detects multiple close events from the socket (e.g.
 * `error` + `close`), the http-host code MUST guard against double-fire by
 * calling `_fireCloseListeners` only once per handle. After the first call,
 * the array is empty and subsequent calls are no-ops — but new listeners
 * registered after a fire will be collected for the next fire.
 */
export function createMcpSubscriberHandle(deps: McpSubscriberHandleDeps): McpSubscriberHandle {
  const { callerContext, serverRef, logger } = deps;
  const connectionId: UUIDv7 = uuidv7();
  const closeListeners: Array<() => void> = [];

  function fireCloseListeners(): void {
    const batch = closeListeners.splice(0);
    for (const cb of batch) {
      try {
        cb();
      } catch (err) {
        logger.warn({ event: 'subscriber_handle_onclose_listener_failed', err });
      }
    }
  }

  return {
    connectionId,
    callerContext,

    async deliver(notification: WaggleNotification): Promise<void> {
      const server = serverRef.deref();
      if (server === undefined) {
        fireCloseListeners();
        throw new Error('McpSubscriberHandle: server gone');
      }
      try {
        await server.sendResourceUpdated({
          uri: `hive://cells/${notification.cellId}`,
          _meta: {
            hiveWaggle: {
              kind: notification.kind,
              recipient_id: notification.recipientId,
              unread_count: notification.unreadCount,
              sender_ids: notification.senderIds,
              emitted_at: notification.emittedAt.toISOString(),
              waggle_id: notification.waggleId,
            },
          },
        });
      } catch (err) {
        fireCloseListeners();
        throw err;
      }
    },

    onClose(callback: () => void): void {
      closeListeners.push(callback);
    },

    _fireCloseListeners: fireCloseListeners,
  };
}
