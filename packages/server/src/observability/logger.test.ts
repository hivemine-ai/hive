import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_REDACT_PATHS,
  createLogger,
  flushLogger,
  getRequestIdFromLogger,
} from './logger.js';

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

describe('createLogger — redact concatenation', () => {
  it('concatenates opts.redact with DEFAULT_REDACT_PATHS, not replaces', () => {
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const log = createLogger({ level: 'info', pretty: false, redact: ['custom.field'] }, dest);

    log.info({ authorization: 'secret', custom: { field: 'sensitive' } }, 'test');

    // pino flushes synchronously to a synchronous Writable
    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output) as Record<string, unknown>;

    // Default path 'authorization' must be redacted
    expect(parsed['authorization']).toBe('[redacted]');
    // Added path 'custom.field' must also be redacted
    const custom = parsed['custom'] as Record<string, unknown>;
    expect(custom['field']).toBe('[redacted]');
  });
});

describe('createLogger — bindings option', () => {
  it('applies bindings to the root logger so every log line carries them', () => {
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const log = createLogger(
      { level: 'info', pretty: false, bindings: { component: 'test' } },
      dest,
    );

    log.info('hi');

    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed['component']).toBe('test');
  });
});

describe('flushLogger', () => {
  it('resolves before timeout when pino completes flush synchronously', async () => {
    const log = createLogger({ level: 'info', pretty: false });
    // Override flush to invoke callback immediately (synchronous completion)
    vi.spyOn(log, 'flush').mockImplementation((cb?: (err?: Error) => void) => {
      cb?.();
    });

    await expect(flushLogger(log, { timeoutMs: 100 })).resolves.toBeUndefined();
  });

  it('resolves silently at timeout when pino never calls back', async () => {
    const log = createLogger({ level: 'info', pretty: false });
    // Override flush to never invoke the callback
    vi.spyOn(log, 'flush').mockImplementation(() => {
      // intentionally never calls cb
    });

    // Use a short timeout so the test stays fast
    await expect(flushLogger(log, { timeoutMs: 20 })).resolves.toBeUndefined();
  });

  it('rejects if pino throws synchronously when starting the flush', async () => {
    const log = createLogger({ level: 'info', pretty: false });
    const boom = new Error('boom');
    vi.spyOn(log, 'flush').mockImplementation(() => {
      throw boom;
    });

    await expect(flushLogger(log, { timeoutMs: 100 })).rejects.toThrow('boom');
  });
});

describe('getRequestIdFromLogger', () => {
  it('returns null for root logger without requestId binding', () => {
    const log = createLogger({ level: 'info', pretty: false });
    expect(getRequestIdFromLogger(log)).toBeNull();
  });

  it('returns the string requestId for a child logger with requestId binding', () => {
    const log = createLogger({ level: 'info', pretty: false });
    const child = log.child({ requestId: '0192abcd-0000-7000-8000-000000000001' });
    expect(getRequestIdFromLogger(child)).toBe('0192abcd-0000-7000-8000-000000000001');
  });

  it('returns null if requestId binding is not a string', () => {
    const log = createLogger({ level: 'info', pretty: false });
    const child = log.child({ requestId: 12345 });
    expect(getRequestIdFromLogger(child)).toBeNull();
  });

  it('returns inherited requestId from grandchild logger', () => {
    const log = createLogger({ level: 'info', pretty: false });
    const child = log.child({ requestId: 'abc' });
    const grandchild = child.child({ otherField: 'x' });
    expect(getRequestIdFromLogger(grandchild)).toBe('abc');
  });
});

describe('DEFAULT_REDACT_PATHS', () => {
  it('is exported and contains the canonical paths', () => {
    expect(DEFAULT_REDACT_PATHS).toContain('authorization');
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.authorization');
    expect(DEFAULT_REDACT_PATHS).toContain('*.authorization');
    expect(DEFAULT_REDACT_PATHS).toContain('*.body');
    expect(DEFAULT_REDACT_PATHS).toContain('*.params.body');
    expect(DEFAULT_REDACT_PATHS).toContain('*.arguments.body');
  });
});
