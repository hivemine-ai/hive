// Decides what happens to each event: print it, run `--exec` for it, or fold it
// into the pending flag. There is no queue and no resend: while a command runs
// (retries included) new events only raise one flag, and afterwards a single
// `check_unread_messages` query decides whether another run is needed.

import {
  AuthRetryWindow,
  DEFAULT_BACKOFF,
  backoffDelay,
  buildQueryEvent,
  isListenError,
} from '@hive/client';
import type { BackoffOptions, LogEntry, UnreadSummary, WatchEvent } from '@hive/client';

import { WatchError } from './errors.js';

export interface DispatcherDeps {
  /** Writes the event line to stdout. */
  emit(event: WatchEvent): void;
  /** Runs the `--exec` command and resolves with its exit code; undefined without `--exec`. */
  exec: ((event: WatchEvent) => Promise<number>) | undefined;
  /** One `check_unread_messages` call. Throws a `ListenError`. */
  requery(): Promise<UnreadSummary>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  random(): number;
  log(entry: LogEntry): void;
  /** Called once when the dispatcher hits an error that must end the process. */
  onFatal(err: WatchError): void;
}

export interface DispatcherOptions {
  signal: AbortSignal;
  /** Extra attempts after the first failure of a command. */
  execMaxRetries: number;
  authRetryMaxMs: number;
  backoff?: BackoffOptions;
}

export interface Dispatcher {
  handle(event: WatchEvent): void;
  /** Resolves when no run is in flight. */
  idle(): Promise<void>;
}

export function createDispatcher(options: DispatcherOptions, deps: DispatcherDeps): Dispatcher {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const { signal } = options;
  const authWindow = new AuthRetryWindow(options.authRetryMaxMs, () => deps.now());
  let busy = false;
  let pending = false;
  let current: Promise<void> = Promise.resolve();

  const delay = (attempt: number): number => backoffDelay(attempt, backoff, () => deps.random());

  async function execWithRetries(
    exec: NonNullable<DispatcherDeps['exec']>,
    event: WatchEvent,
  ): Promise<void> {
    const attempts = options.execMaxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let failure: string;
      try {
        const code = await exec(event);
        if (code === 0) return;
        failure = `exited with code ${String(code)}`;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (signal.aborted) return;
      deps.log({ event: 'watch.exec_failed', attempt: attempt + 1, of: attempts, failure });
      if (attempt + 1 < attempts) await deps.sleep(delay(attempt), signal);
    }
    throw new WatchError(
      'WATCH_EXEC_FAILED',
      `the command failed ${String(attempts)} time(s) for event ${event.eventId}`,
    );
  }

  /** Clears the flag and queries until it gets an answer; returns the event to run, if any. */
  async function resolvePending(): Promise<WatchEvent | null> {
    let attempt = 0;
    while (pending && !signal.aborted) {
      pending = false;
      try {
        const summary = await deps.requery();
        authWindow.success();
        const event = buildQueryEvent(summary);
        if (event !== null) return event;
      } catch (err) {
        pending = true;
        if (signal.aborted) return null;
        let wait = delay(attempt);
        if (isListenError(err) && err.kind === 'auth_rejected') {
          const verdict = authWindow.reject();
          if (verdict.giveUp) {
            throw new WatchError(
              'WATCH_CREDENTIAL_REJECTED',
              'the server kept rejecting the credential while checking unread messages',
              { cause: err },
            );
          }
          wait = Math.min(wait, verdict.remainingMs);
        }
        if (isListenError(err) && err.kind === 'protocol_unsupported') {
          throw new WatchError('WATCH_PROTOCOL_UNSUPPORTED', err.message, { cause: err });
        }
        attempt += 1;
        deps.log({ event: 'watch.requery_failed', retryInMs: wait });
        await deps.sleep(wait, signal);
      }
    }
    return null;
  }

  async function cycle(first: WatchEvent): Promise<void> {
    const exec = deps.exec;
    if (exec === undefined) return;
    try {
      let next: WatchEvent | null = first;
      while (next !== null && !signal.aborted) {
        deps.emit(next);
        await execWithRetries(exec, next);
        next = signal.aborted ? null : await resolvePending();
      }
    } catch (err) {
      deps.onFatal(
        err instanceof WatchError ? err : new WatchError('WATCH_EXEC_FAILED', String(err)),
      );
    } finally {
      busy = false;
    }
  }

  return {
    handle(event) {
      if (deps.exec === undefined) {
        deps.emit(event);
        return;
      }
      if (busy) {
        pending = true;
        return;
      }
      if (signal.aborted) return;
      busy = true;
      current = cycle(event);
    },
    idle: () => current,
  };
}
