// The single listen stream of the session (ADR-026 3.a.5): the reconnecting loop
// of `hivectl watch` with its lease (ADR-025), silence detector and backoff,
// opened with whatever Worker token is current at each (re)connection. The
// server replays on every new stream and re-binds an open one on renewal, so the
// stream is never reopened for a renewal.
//
// An auth rejection is not retried here: the session renews or registers again
// first (onAuthRejected) and then restarts the stream.

import { createRuntimeDeps, createSdkConnector, isListenError, runListenLoop } from '@hive/client';
import type { BackoffOptions, LogEntry, WatchEvent } from '@hive/client';

import type { FetchLike } from './upstream.js';

export interface StreamOptions {
  url: string;
  clientVersion: string;
  probeTimeoutMs: number;
  silenceTimeoutMs: number;
  backoff?: BackoffOptions;
  fetch?: FetchLike;
  token(): string | undefined;
  onEvent(event: WatchEvent): void;
  onConnected(): void;
  onAuthRejected(): void;
  onFatal(message: string): void;
  log(entry: LogEntry): void;
}

export interface SessionStream {
  readonly running: boolean;
  start(): void;
  /** Closes the stream (the participant goes offline at once) and waits for the loop. */
  stop(): Promise<void>;
}

export function createSessionStream(options: StreamOptions): SessionStream {
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;

  const connect = (
    handlers: Parameters<ReturnType<typeof createSdkConnector>>[0],
    signal: AbortSignal,
  ) => {
    const token = options.token();
    if (token === undefined) {
      return Promise.reject(new Error('no Worker token to open the stream with'));
    }
    return createSdkConnector({
      url: options.url,
      credential: token,
      probeTimeoutMs: options.probeTimeoutMs,
      silenceTimeoutMs: options.silenceTimeoutMs,
      clientName: 'hivectl-mcp-proxy',
      clientVersion: options.clientVersion,
      ...(options.fetch && { fetch: options.fetch }),
    })(handlers, signal);
  };

  const log = (entry: LogEntry): void => {
    if (entry.event === 'watch.connected') options.onConnected();
    options.log(entry);
  };

  return {
    get running() {
      return controller !== undefined;
    },
    start() {
      if (controller !== undefined) return;
      const own = new AbortController();
      controller = own;
      loop = runListenLoop(
        {
          signal: own.signal,
          authRetryMaxMs: 0,
          onEvent: (event) => options.onEvent(event),
          ...(options.backoff && { backoff: options.backoff }),
        },
        createRuntimeDeps(connect, log),
      ).then(
        () => undefined,
        (err: unknown) => {
          if (controller === own) controller = undefined;
          if (own.signal.aborted) return;
          if (isListenError(err) && err.kind === 'auth_rejected') options.onAuthRejected();
          else options.onFatal(err instanceof Error ? err.message : String(err));
        },
      );
    },
    async stop() {
      const own = controller;
      controller = undefined;
      own?.abort();
      await loop;
    },
  };
}
