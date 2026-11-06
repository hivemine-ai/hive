import { describe, expect, it } from 'vitest';

import { createDiagnostics, parseLogLevel } from './diagnostics.js';

describe('createDiagnostics', () => {
  it('writes JSON lines at or above the level and masks every registered secret', () => {
    const lines: string[] = [];
    const diag = createDiagnostics(
      (l) => lines.push(l),
      'warn',
      () => new Date(0),
    );
    diag.secret('tok-123');

    diag.log('info', 'proxy.quiet');
    diag.log('warn', 'proxy.loud', { detail: 'Bearer tok-123 failed' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'warn',
      event: 'proxy.loud',
      detail: 'Bearer [redacted] failed',
    });
  });

  it('defaults to warn for an unknown level and survives a failing writer', () => {
    expect(parseLogLevel(undefined)).toBe('warn');
    expect(parseLogLevel('chatty')).toBe('warn');
    expect(parseLogLevel('toString')).toBe('warn');
    expect(parseLogLevel('debug')).toBe('debug');
    const diag = createDiagnostics(() => {
      throw new Error('EPIPE');
    }, 'debug');
    expect(() => diag.log('error', 'x')).not.toThrow();
  });
});
