import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  /** Min level to emit. Default: process.env.HIVE_LOG_LEVEL ?? 'info'. */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** Force pino-pretty regardless of NODE_ENV. Tests may set true for selective silencing. */
  pretty?: boolean;
  /**
   * Additional redact paths concatenated with DEFAULT_REDACT_PATHS.
   * Use when a new surface introduces sensitive fields outside the default set.
   */
  redact?: string[];
  /** Optional bindings applied to the root logger (not per log line). */
  bindings?: Record<string, unknown>;
}

export interface FlushOptions {
  /** Max time (ms) to wait for the flush. Default 100ms. */
  timeoutMs?: number;
}

/**
 * Default redact paths — Authorization header and message body in any tool
 * call payload. Override with `LoggerOptions.redact` if a process needs more.
 */
export const DEFAULT_REDACT_PATHS: ReadonlyArray<string> = [
  'authorization',
  'req.headers.authorization',
  '*.authorization',
  '*.body',
  '*.params.body',
  '*.arguments.body',
];

/**
 * Builds the application logger.
 * Pretty (colored) in dev (NODE_ENV !== 'production'), JSON in prod.
 *
 * `redact` masks DEFAULT_REDACT_PATHS + opts.redact with `[redacted]`.
 * `bindings` are applied to the root logger so every line carries them.
 */
export function createLogger(opts: LoggerOptions = {}, dest?: DestinationStream): Logger {
  const level = opts.level ?? process.env['HIVE_LOG_LEVEL'] ?? 'info';
  const usePretty = opts.pretty ?? process.env['NODE_ENV'] !== 'production';
  const redact = [...DEFAULT_REDACT_PATHS, ...(opts.redact ?? [])];

  let root: Logger;

  if (dest !== undefined) {
    root = pino({ level, redact: { paths: redact, censor: '[redacted]' } }, dest);
  } else if (usePretty) {
    root = pino({
      level,
      redact: { paths: redact, censor: '[redacted]' },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: true,
          translateTime: 'SYS:HH:MM:ss.l',
        },
      },
    });
  } else {
    root = pino({ level, redact: { paths: redact, censor: '[redacted]' } });
  }

  return opts.bindings !== undefined ? root.child(opts.bindings) : root;
}

/**
 * Force pino flush with timeout. Resolves in <= timeoutMs:
 * - Resolves OK if pino completed the flush before the timeout.
 * - Resolves OK silently if it reaches the timeout (best-effort — no throw).
 * - Rejects ONLY if pino itself throws a synchronous error when starting the flush.
 *
 * Default timeout 100ms.
 */
export function flushLogger(logger: Logger, opts?: FlushOptions): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 100;

  return new Promise<void>((resolve, reject) => {
    try {
      logger.flush(() => resolve());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    setTimeout(resolve, timeoutMs);
  });
}

/**
 * Extracts the `requestId` binding from a logger's context.
 * Returns the string value if present, null otherwise.
 */
export function getRequestIdFromLogger(logger: Logger): string | null {
  const bindings = logger.bindings();
  const requestId: unknown = bindings['requestId'];
  return typeof requestId === 'string' ? requestId : null;
}
