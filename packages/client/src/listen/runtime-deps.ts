import type { ListenLoopDeps, LogEntry } from './listen-loop.js';

/** Sleeps for `ms`, or until `signal` aborts, whichever comes first. Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Real clock, timers and randomness for {@link runListenLoop}. */
export function createRuntimeDeps(
  connect: ListenLoopDeps['connect'],
  log: (entry: LogEntry) => void,
): ListenLoopDeps {
  return {
    connect,
    sleep: abortableSleep,
    now: () => Date.now(),
    random: () => Math.random(),
    log,
  };
}
