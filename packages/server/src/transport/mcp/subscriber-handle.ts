import { v7 as uuidv7 } from 'uuid';
import type { Logger } from 'pino';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import type { WaggleNotification } from '#domain/notifications/waggle/types.js';

import type { SubscriberHandle } from '#domain/notifications/presence/subscriber-handle.js';

/**
 * Minimal subset of the MCP SDK's `Server` that we depend on. Lets us mock the
 * SDK in tests and keeps the handle decoupled from the SDK class hierarchy.
 *
 * Two methods, one per envelope of the dual-emit (per ADR-011):
 *   - `sendResourceUpdated` — MCP-standard `notifications/resources/updated`
 *     wrapping the Hive payload in `_meta.hiveWaggle` (Envelope 1).
 *   - `sendChannelNotification` — Claude Code Channels
 *     `notifications/claude/channel` (Envelope 2). Wraps
 *     `mcpServer.server.notification()` with the method pinned to the Channels
 *     namespace; `params.content` is a string and `params.meta` is a flat
 *     `Record<string, string>` rendered as XML attributes by Claude Code.
 */
export interface McpServerNotifier {
  sendResourceUpdated(params: { uri: string; _meta?: Record<string, unknown> }): Promise<void>;
  sendChannelNotification(params: { content: string; meta: Record<string, string> }): Promise<void>;
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
 * Build the canonical `params.content` string for an Envelope 2 emit. The
 * string lives inside `<channel>...</channel>` once Claude Code injects it
 * into the model context. Form: human-readable prose pluralized by count,
 * followed by an HTML comment carrying traceability metadata that does not
 * pollute the prose visible to the model.
 */
export function buildChannelContent(notification: WaggleNotification): string {
  const messageWord = notification.unreadCount === 1 ? 'message' : 'messages';
  const prose = `You have ${String(notification.unreadCount)} unread ${messageWord} in your mailbox. Run check_unread_messages to read.`;
  const trace = `<!-- waggle: kind=${notification.kind}, waggle_id=${notification.waggleId}, emitted_at=${notification.emittedAt.toISOString()} -->`;
  return `${prose}\n\n${trace}`;
}

/**
 * Build the `params.meta` record for an Envelope 2 emit. Each entry becomes an
 * XML attribute on the `<channel>` tag in the model context. Claude Code
 * silently drops keys with non-identifier characters; all six keys here use
 * letters/digits/underscores only.
 */
export function buildChannelMeta(notification: WaggleNotification): Record<string, string> {
  return {
    cell_id: notification.cellId,
    kind: notification.kind,
    unread_count: String(notification.unreadCount),
    sender_ids: notification.senderIds.join(','),
    waggle_id: notification.waggleId,
    emitted_at: notification.emittedAt.toISOString(),
  };
}

/**
 * Concrete handle implementing `SubscriberHandle` for an MCP session.
 *
 * Lifecycle:
 *   - `deliver(notification)` is invoked by the Waggle pipeline (online or
 *     replay). It performs a dual emit per ADR-011:
 *       1. `notifications/resources/updated` with `_meta.hiveWaggle` payload —
 *          MCP-standard path. If this throws, propagate (the connection is
 *          broken) and fire close listeners.
 *       2. `notifications/claude/channel` with `params.content` (string) and
 *          `params.meta` (Record<string, string>) — Claude Code Channels path.
 *          Fail-safe: if this throws (channel-config drift, socket closed
 *          between emits, SDK error), log warn and continue. Emit 1 already
 *          delivered; Emit 2 is additive per ADR-011.
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

      // Emit 1 — MCP-standard: notifications/resources/updated. If this
      // throws, the connection is broken; propagate and fire close listeners
      // so the registry can deregister.
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

      // Emit 2 — Claude Code Channels: notifications/claude/channel. Per
      // ADR-011 (dual emit). Fail-safe: if this rejects, log warn and
      // continue. Emit 1 already delivered; Emit 2 is additive — losing it
      // costs reactive autonomy in Claude Code but the standard path still
      // notifies the client.
      try {
        await server.sendChannelNotification({
          content: buildChannelContent(notification),
          meta: buildChannelMeta(notification),
        });
      } catch (err) {
        logger.warn(
          {
            event: 'mcp_channel_emit_failed',
            cellId: notification.cellId,
            waggleId: notification.waggleId,
            err: err instanceof Error ? err.message : String(err),
          },
          'notifications/claude/channel emit failed; resources/updated already delivered',
        );
      }
    },

    onClose(callback: () => void): void {
      closeListeners.push(callback);
    },

    _fireCloseListeners: fireCloseListeners,
  };
}
