import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  // Force pretty output regardless of NODE_ENV. Used by tests to stay quiet.
  pretty?: boolean;
  /**
   * Pino redact paths. Defaults to `Authorization` header masking and message
   * body masking — both invariants of the MCP transport per the tech spec
   * § "Consideraciones de seguridad".
   */
  redact?: string[];
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
 * `redact` masks the matched paths with `[redacted]`. The default set covers
 * the JWT and message body — never log either by default.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env['HIVE_LOG_LEVEL'] ?? 'info';
  const usePretty = opts.pretty ?? process.env['NODE_ENV'] !== 'production';
  const redact = opts.redact ?? Array.from(DEFAULT_REDACT_PATHS);

  if (usePretty) {
    return pino({
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
  }

  return pino({ level, redact: { paths: redact, censor: '[redacted]' } });
}
