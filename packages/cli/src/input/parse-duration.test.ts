import { describe, expect, it } from 'vitest';

import { parseDuration } from './parse-duration.js';

interface CliErrorLike {
  name: string;
  code: string;
  subCode?: string;
  message: string;
}

function isCliErrorLike(err: unknown): err is CliErrorLike {
  return err instanceof Error && err.name === 'CliError' && 'code' in err;
}

describe('parseDuration', () => {
  it('parses pure ms when no suffix', () => {
    expect(parseDuration('500')).toBe(500);
    expect(parseDuration('1000')).toBe(1000);
  });

  it('parses ms suffix', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1ms')).toBe(1);
  });

  it('parses seconds', () => {
    expect(parseDuration('5s')).toBe(5_000);
    expect(parseDuration('60s')).toBe(60_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(5 * 60 * 1000);
    expect(parseDuration('60m')).toBe(60 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(60 * 60 * 1000);
    expect(parseDuration('12h')).toBe(12 * 60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('365d')).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('trims whitespace', () => {
    expect(parseDuration('  10s  ')).toBe(10_000);
  });

  it('rejects malformed input', () => {
    expect(() => parseDuration('foo')).toThrow(/cannot parse duration/);
    expect(() => parseDuration('30x')).toThrow(/cannot parse duration/);
    expect(() => parseDuration('')).toThrow(/cannot parse duration/);
  });

  it('rejects zero or negative values', () => {
    expect(() => parseDuration('0')).toThrow(/duration must be positive/);
    expect(() => parseDuration('0d')).toThrow(/duration must be positive/);
  });

  it('throws CliError with subCode duration_invalid', () => {
    try {
      parseDuration('abc');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCliErrorLike(err)).toBe(true);
      if (isCliErrorLike(err)) {
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.subCode).toBe('duration_invalid');
      }
    }
  });
});
