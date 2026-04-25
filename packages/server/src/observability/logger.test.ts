import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('returns a pino logger instance with the requested level', () => {
    const log = createLogger({ level: 'warn', pretty: false });
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(log.level).toBe('warn');
  });

  it('falls back to "info" level when nothing is configured', () => {
    const log = createLogger({ pretty: false });
    expect(log.level).toBe('info');
  });

  it('honors HIVE_LOG_LEVEL when set in env', () => {
    const original = process.env['HIVE_LOG_LEVEL'];
    process.env['HIVE_LOG_LEVEL'] = 'debug';
    try {
      const log = createLogger({ pretty: false });
      expect(log.level).toBe('debug');
    } finally {
      if (original === undefined) {
        delete process.env['HIVE_LOG_LEVEL'];
      } else {
        process.env['HIVE_LOG_LEVEL'] = original;
      }
    }
  });
});
