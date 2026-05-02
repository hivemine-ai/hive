import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_REDACT_PATHS,
  __resetSeaWarnForTests,
  __setSeaDetectorForTests,
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

describe('createLogger — SEA detection (INC-2026-004)', () => {
  beforeEach(() => {
    __setSeaDetectorForTests(() => true);
    __resetSeaWarnForTests();
  });

  afterEach(() => {
    __setSeaDetectorForTests(undefined);
    __resetSeaWarnForTests();
    vi.restoreAllMocks();
  });

  it('forces JSON output (no pretty transport) when running inside a SEA binary', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const log = createLogger({ level: 'info', pretty: true });
    log.info('sea-test-line');

    const warnCalls = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('[hivectl] pretty logs are not available'));
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('| npx pino-pretty');

    // The log line travels to stdout synchronously (no transport branch =
    // direct sonic-boom). A pino-pretty transport would route through a
    // worker_thread and never hit this stdout spy in the same tick — and
    // would also crash inside vitest the same way it crashes in the SEA.
    const jsonLines = stdoutSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"sea-test-line"'));
    expect(jsonLines).toHaveLength(1);
    const firstLine = jsonLines[0];
    if (firstLine === undefined) throw new Error('expected at least one JSON line');
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    expect(parsed['msg']).toBe('sea-test-line');
    expect(parsed['level']).toBe(30);
  });

  it('emits the SEA warn at most once per process even on repeated createLogger calls', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    createLogger({ level: 'info', pretty: true });
    createLogger({ level: 'info', pretty: true });
    createLogger({ level: 'info', pretty: true });

    const warnCalls = writeSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('[hivectl] pretty logs are not available'));
    expect(warnCalls).toHaveLength(1);
  });

  it('does NOT emit the SEA warn when the operator did not request pretty mode', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    createLogger({ level: 'info', pretty: false });
    createLogger({ level: 'info' });

    const warnCalls = writeSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('[hivectl] pretty logs are not available'));
    expect(warnCalls).toHaveLength(0);
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
