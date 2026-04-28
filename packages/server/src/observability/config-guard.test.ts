import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { warnSweepMisconfig } from './config-guard.js';
import { createLogger } from './logger.js';

type CaptureLogger = ReturnType<typeof createLogger>;

function buildCaptureLogger(): {
  logger: CaptureLogger;
  getLines: () => Record<string, unknown>[];
} {
  const rawLines: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      rawLines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ level: 'info', pretty: false }, dest);
  return {
    logger,
    getLines: () =>
      rawLines
        .flatMap((raw) => raw.split('\n').filter((l) => l.trim() !== ''))
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('warnSweepMisconfig', () => {
  it('emits a warn iff enabledMs > 0 and intervalMs <= 0', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'TestComponent', { enabledMs: 1000, intervalMs: 0 });

    const lines = getLines();
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line['level']).toBe(40);
    expect(line['event']).toBe('config_sweep_misconfigured');
    expect(line['component']).toBe('TestComponent');
    expect(line['enabledMs']).toBe(1000);
    expect(line['intervalMs']).toBe(0);
    expect(line['msg']).toBe(
      'TestComponent: enabledMs > 0 but intervalMs <= 0 — sweep will not run',
    );
  });

  it('emits a warn when intervalMs is negative', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'NegativeInterval', { enabledMs: 100, intervalMs: -50 });

    const lines = getLines();
    expect(lines.length).toBe(1);
    expect(lines[0]!['event']).toBe('config_sweep_misconfigured');
  });

  it('does not log when enabledMs is null (sweep disabled)', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'Disabled', { enabledMs: null, intervalMs: 0 });

    expect(getLines().length).toBe(0);
  });

  it('does not log when enabledMs is 0 (sweep disabled)', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'Zero', { enabledMs: 0, intervalMs: 0 });

    expect(getLines().length).toBe(0);
  });

  it('does not log when intervalMs > 0 (well-configured)', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'Healthy', { enabledMs: 30_000, intervalMs: 5_000 });

    expect(getLines().length).toBe(0);
  });

  it('does not log when both enabledMs is null and intervalMs > 0', () => {
    const { logger, getLines } = buildCaptureLogger();
    warnSweepMisconfig(logger, 'NullEnabledWithInterval', { enabledMs: null, intervalMs: 1000 });

    expect(getLines().length).toBe(0);
  });

  it('emits one warn per call (not idempotent — caller is responsible for single-call)', () => {
    const { logger, getLines } = buildCaptureLogger();
    const config = { enabledMs: 1000, intervalMs: 0 };
    warnSweepMisconfig(logger, 'Caller', config);
    warnSweepMisconfig(logger, 'Caller', config);
    warnSweepMisconfig(logger, 'Caller', config);

    expect(getLines().length).toBe(3);
  });
});
