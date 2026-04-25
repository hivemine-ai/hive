import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  // Force pretty output regardless of NODE_ENV. Used by tests to stay quiet.
  pretty?: boolean;
}

/**
 * Builds the application logger.
 * Pretty (colored) in dev (NODE_ENV !== 'production'), JSON in prod.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env['HIVE_LOG_LEVEL'] ?? 'info';
  const usePretty = opts.pretty ?? process.env['NODE_ENV'] !== 'production';

  if (usePretty) {
    return pino({
      level,
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

  return pino({ level });
}
