// The real `connect` used by the listen loop: opens one `subscriptions/listen`
// stream on the caller's own mailbox, validates every event and watches for
// silence. It calls no tool: the mailbox URI comes from `resources/list`.
//
// Every connection asks for a lease. If the server grants one, a renewal goes out
// every quarter of it until the stream ends. A failed renewal is ignored: the
// silence detector still decides when to reconnect.

import { ListenError } from './errors.js';
import { parseWaggleMeta } from './event.js';
import { beatIntervalMs, createLease } from './lease-fetch.js';
import type { CloseReason, ConnectHandlers, ListenConnection } from './listen-loop.js';
import { closeClient, connectClient, settleWithin, toListenError } from './sdk-client.js';
import type { SdkClientOptions } from './sdk-client.js';

export interface SdkConnectorOptions extends Omit<SdkClientOptions, 'onBytes'> {
  /** Close the connection after this long without a single byte. */
  silenceTimeoutMs: number;
}

const SILENCE_CHECK_MS = 1000;

export function createSdkConnector(
  options: SdkConnectorOptions,
): (handlers: ConnectHandlers, signal: AbortSignal) => Promise<ListenConnection> {
  return async (handlers, signal) => {
    let lastByteAt = Date.now();
    const lease = createLease();
    const client = await connectClient({
      ...options,
      lease,
      onBytes: () => {
        lastByteAt = Date.now();
      },
    });
    let mailboxUri: string | undefined;

    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      const params = notification.params as { uri?: unknown; _meta?: Record<string, unknown> };
      if (mailboxUri !== undefined && params.uri !== mailboxUri) return;
      const event = parseWaggleMeta(params._meta?.['hiveWaggle']);
      if (event === null) handlers.onDiscard('invalid event shape');
      else handlers.onEvent(event);
    });

    try {
      const listed = await client.listResources();
      mailboxUri = listed.resources[0]?.uri;
      if (listed.resources.length !== 1 || mailboxUri === undefined) {
        throw new ListenError(
          'transport',
          'the server did not expose exactly one mailbox resource',
        );
      }
      const subscription = await client.listen({ resourceSubscriptions: [mailboxUri] }, { signal });
      lastByteAt = Date.now();

      const leaseMs = lease.leaseMs;
      let beat: NodeJS.Timeout | undefined;
      if (leaseMs !== null) {
        const everyMs = beatIntervalMs(leaseMs);
        beat = setInterval(() => {
          client.discover({ timeout: everyMs }).catch(() => undefined);
        }, everyMs);
        beat.unref();
      }
      const stopBeat = (): void => {
        clearInterval(beat);
        beat = undefined;
      };

      let timer: NodeJS.Timeout | undefined;
      const silence = new Promise<CloseReason>((resolve) => {
        timer = setInterval(
          () => {
            if (Date.now() - lastByteAt > options.silenceTimeoutMs) resolve('silence');
          },
          Math.min(SILENCE_CHECK_MS, Math.max(10, options.silenceTimeoutMs / 4)),
        );
        timer.unref();
      });
      const closed: Promise<CloseReason> = Promise.race([subscription.closed, silence]).finally(
        () => {
          if (timer) clearInterval(timer);
          stopBeat();
        },
      );
      return {
        closed,
        leaseMs,
        close: async () => {
          if (timer) clearInterval(timer);
          stopBeat();
          await settleWithin(subscription.close());
          await closeClient(client);
        },
      };
    } catch (err) {
      await closeClient(client);
      throw toListenError(err);
    }
  };
}
