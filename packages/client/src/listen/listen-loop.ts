// The reconnecting core of `hivectl watch`. One connection at a time; after any
// cut it reconnects with backoff and recovers through the server's replay, so
// it never queries anything on connect and never keeps a position.

import { AuthRetryWindow, DEFAULT_BACKOFF, backoffDelay } from './backoff.js';
import type { BackoffOptions } from './backoff.js';
import { isListenError } from './errors.js';
import type { WatchEvent } from './event.js';

export type CloseReason = 'local' | 'graceful' | 'remote' | 'silence';

export interface ListenConnection {
  /** Resolves once, never rejects, when the stream ends. */
  readonly closed: Promise<CloseReason>;
  /** Lease granted by the server; null when it granted none (or does not support it). */
  readonly leaseMs?: number | null;
  close(): Promise<void>;
}

export interface ConnectHandlers {
  onEvent(event: WatchEvent): void;
  /** An event was dropped because its shape was invalid. */
  onDiscard(reason: string): void;
}

export interface LogEntry {
  event: string;
  [key: string]: unknown;
}

export interface ListenLoopDeps {
  /** Opens a stream and resolves after its acknowledgment. Throws a `ListenError`. */
  connect(handlers: ConnectHandlers, signal: AbortSignal): Promise<ListenConnection>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  random(): number;
  log(entry: LogEntry): void;
}

export interface ListenLoopOptions {
  signal: AbortSignal;
  authRetryMaxMs: number;
  onEvent(event: WatchEvent): void;
  backoff?: BackoffOptions;
  /** A connection that lived at least this long resets the backoff. */
  stableMs?: number;
}

const DEFAULT_STABLE_MS = 10_000;

function whenAborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

/**
 * Runs until `signal` aborts. Rejects with a `ListenError` of kind
 * `auth_rejected` once the rejection window is spent, or `protocol_unsupported`
 * at once. Any other failure is retried forever.
 */
export async function runListenLoop(
  options: ListenLoopOptions,
  deps: ListenLoopDeps,
): Promise<void> {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const window = new AuthRetryWindow(options.authRetryMaxMs, () => deps.now());
  const aborted = whenAborted(options.signal);
  let failures = 0;

  while (!options.signal.aborted) {
    let lastEventId: string | undefined;
    const handlers: ConnectHandlers = {
      onEvent: (event) => {
        if (event.eventId === lastEventId) {
          deps.log({ event: 'watch.duplicate', eventId: event.eventId });
          return;
        }
        lastEventId = event.eventId;
        options.onEvent(event);
      },
      onDiscard: (reason) => deps.log({ event: 'watch.discarded', reason }),
    };

    let connection: ListenConnection;
    try {
      connection = await deps.connect(handlers, options.signal);
    } catch (err) {
      if (options.signal.aborted) break;
      const kind = isListenError(err) ? err.kind : 'transport';
      const message = err instanceof Error ? err.message : String(err);
      if (kind === 'protocol_unsupported') throw err;
      let delay = backoffDelay(failures, backoff, () => deps.random());
      if (kind === 'auth_rejected') {
        const verdict = window.reject();
        if (verdict.giveUp) throw err;
        delay = Math.min(delay, verdict.remainingMs);
      }
      failures += 1;
      deps.log({ event: 'watch.connect_failed', kind, message, retryInMs: delay });
      await deps.sleep(delay, options.signal);
      continue;
    }

    window.success();
    const connectedAt = deps.now();
    deps.log({ event: 'watch.connected', leaseMs: connection.leaseMs ?? null });
    const outcome = await Promise.race([connection.closed, aborted]);
    await connection.close().catch(() => {});
    if (outcome === 'aborted' || options.signal.aborted) break;

    failures = deps.now() - connectedAt >= stableMs ? 0 : failures + 1;
    const delay = backoffDelay(Math.max(0, failures - 1), backoff, () => deps.random());
    deps.log({ event: 'watch.disconnected', reason: outcome, retryInMs: delay });
    await deps.sleep(delay, options.signal);
  }
}
