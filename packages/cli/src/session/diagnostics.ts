// Diagnostics of the proxy: JSON lines on stderr (stdout carries only MCP), at
// the level of HIVE_PROXY_LOG_LEVEL (default warn). Every secret the proxy ever
// handled (enrollment credential, Worker tokens) is masked in every line.

export type ProxyLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<ProxyLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export function parseLogLevel(raw: string | undefined): ProxyLogLevel {
  return raw !== undefined && Object.hasOwn(RANK, raw) ? (raw as ProxyLogLevel) : 'warn';
}

export interface Diagnostics {
  log(
    level: Exclude<ProxyLogLevel, 'silent'>,
    event: string,
    fields?: Record<string, unknown>,
  ): void;
  /** Registers a value that must never appear in a line. */
  secret(value: string): void;
}

export function createDiagnostics(
  write: (line: string) => void,
  level: ProxyLogLevel,
  now: () => Date = () => new Date(),
): Diagnostics {
  const secrets = new Set<string>();
  return {
    secret(value) {
      if (value !== '') secrets.add(value);
    },
    log(entryLevel, event, fields = {}) {
      if (RANK[entryLevel] < RANK[level]) return;
      let line = JSON.stringify({ ts: now().toISOString(), level: entryLevel, event, ...fields });
      for (const value of secrets) line = line.split(value).join('[redacted]');
      try {
        write(`${line}\n`);
      } catch {
        // A closed stderr must never take the proxy down.
      }
    },
  };
}
