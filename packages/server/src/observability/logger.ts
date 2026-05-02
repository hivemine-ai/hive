import { createRequire } from 'node:module';
import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';

export type { Logger };

const SEA_PRETTY_WARN =
  '[hivectl] pretty logs are not available in the SEA binary; emitting JSON. ' +
  "To get pretty output, pipe stderr through pino-pretty: 'hivectl ... 2>&1 | npx pino-pretty'\n";

// node:sea is a static built-in import that vite's resolver (vitest 2.x)
// does not recognize, so use createRequire to load it at runtime instead.
// Returns false in any environment where the module is unavailable
// (Node < 19.7) or the call throws — defensive default matches the
// not-in-SEA contract.
const requireFn = createRequire(import.meta.url);
let seaDetector: () => boolean = () => {
  try {
    const sea = requireFn('node:sea') as { isSea: () => boolean };
    return sea.isSea();
  } catch {
    return false;
  }
};

let seaPrettyWarnEmitted = false;

/**
 * Test-only helper to override SEA detection. Pass `undefined` to restore
 * the real detector. Production code never calls this.
 */
export function __setSeaDetectorForTests(impl: (() => boolean) | undefined): void {
  seaDetector = impl ?? defaultSeaDetector;
}

const defaultSeaDetector = seaDetector;

/**
 * Test-only helper to reset the one-shot SEA warn flag between cases.
 * Production code never calls this.
 */
export function __resetSeaWarnForTests(): void {
  seaPrettyWarnEmitted = false;
}

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
  const inSea = seaDetector();
  // pino transports use worker_threads + require.resolve(<target>), which expects
  // the transport module on disk. Inside a SEA, pino-pretty is bundled into
  // bundle.cjs (no on-disk path), so the worker resolve fails with
  // `fatal: unable to determine transport target for "pino-pretty"`. Force JSON
  // output when running inside a SEA — see INC-2026-004 + ADR-019.
  const usePretty = inSea ? false : (opts.pretty ?? process.env['NODE_ENV'] !== 'production');
  if (inSea && opts.pretty === true && !seaPrettyWarnEmitted) {
    seaPrettyWarnEmitted = true;
    process.stderr.write(SEA_PRETTY_WARN);
  }
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
    const timer = setTimeout(resolve, timeoutMs);
    try {
      logger.flush(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
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
