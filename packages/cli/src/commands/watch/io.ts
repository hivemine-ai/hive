import type { BackoffOptions, LogEntry } from '@hive/client';

/** Side effects of `watch`, injected so tests can observe them. */
export interface WatchIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  /** Aborts on SIGINT or SIGTERM. */
  signal: AbortSignal;
  /** Test override of the reconnect and retry backoff. */
  backoff?: BackoffOptions;
}

/** Builds the stderr diagnostic writer. It scrubs the credential from every line. */
export function createDiagnostics(io: Pick<WatchIo, 'stderr'>, credential: string) {
  const scrub = (text: string): string =>
    credential === '' ? text : text.split(credential).join('[redacted]');
  return (entry: LogEntry): void => {
    io.stderr(`${scrub(JSON.stringify({ ts: new Date().toISOString(), ...entry }))}\n`);
  };
}
