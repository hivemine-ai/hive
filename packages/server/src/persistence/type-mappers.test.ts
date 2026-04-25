import { describe, expect, it } from 'vitest';

import {
  boolToInt,
  dateToIso,
  intToBool,
  isoToDate,
  jsonParse,
  jsonStringify,
  validateJsonText,
} from './type-mappers.js';

describe('dateToIso / isoToDate', () => {
  it('round-trips a UTC date losslessly', () => {
    const original = new Date('2026-04-25T12:34:56.789Z');
    const iso = dateToIso(original);
    expect(iso).toBe('2026-04-25T12:34:56.789Z');
    expect(isoToDate(iso).getTime()).toBe(original.getTime());
  });

  it('round-trips a date with non-UTC source timezone (output is always UTC)', () => {
    // Date constructed from a local-tz string still serializes to UTC.
    const original = new Date('2026-12-31T23:59:59-03:00');
    const iso = dateToIso(original);
    expect(iso).toBe('2027-01-01T02:59:59.000Z');
    expect(isoToDate(iso).getTime()).toBe(original.getTime());
  });

  it('rejects an invalid ISO string', () => {
    expect(() => isoToDate('not a date')).toThrow(/Invalid ISO 8601 timestamp/);
  });
});

describe('jsonStringify / jsonParse', () => {
  it('round-trips a complex object', () => {
    const value = {
      a: 'hello',
      b: 42,
      c: [1, 2, 3],
      d: { nested: true },
      e: null,
    };
    const text = jsonStringify(value);
    expect(jsonParse<typeof value>(text)).toEqual(value);
  });

  it('round-trips strings with non-ASCII characters', () => {
    const value = { greeting: '¡Hola, ñandú! 🐝', emoji: '✨' };
    const parsed = jsonParse<typeof value>(jsonStringify(value));
    expect(parsed).toEqual(value);
  });
});

describe('validateJsonText', () => {
  it('accepts payloads under the limit', () => {
    expect(() => validateJsonText('{"a":1}', { maxBytes: 1024 })).not.toThrow();
  });

  it('rejects payloads over the limit', () => {
    const big = 'x'.repeat(5000);
    expect(() => validateJsonText(big, { maxBytes: 4096 })).toThrow(/JSON payload exceeds limit/);
  });

  it('counts UTF-8 bytes (multi-byte chars contribute >1 byte)', () => {
    // '🐝' is 4 UTF-8 bytes. Repeating 100 times = 400 bytes; limit 200 should fail.
    const text = '🐝'.repeat(100);
    expect(() => validateJsonText(text, { maxBytes: 200 })).toThrow();
  });
});

describe('boolToInt / intToBool', () => {
  it('round-trips true', () => {
    expect(intToBool(boolToInt(true))).toBe(true);
  });

  it('round-trips false', () => {
    expect(intToBool(boolToInt(false))).toBe(false);
  });

  it('intToBool treats any nonzero as true', () => {
    expect(intToBool(1)).toBe(true);
    expect(intToBool(7)).toBe(true);
    expect(intToBool(-1)).toBe(true);
    expect(intToBool(0)).toBe(false);
  });
});
