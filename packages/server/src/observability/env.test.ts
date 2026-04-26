import { describe, expect, it } from 'vitest';

import { parseBoolEnv, parseIntEnv, parseNullableIntEnv } from './env.js';

describe('parseIntEnv', () => {
  const opts = { name: 'HIVE_TEST_X', min: 0 };

  it('returns parsed integer when value is well-formed', () => {
    expect(parseIntEnv('42', 99, opts)).toBe(42);
    expect(parseIntEnv('0', 99, opts)).toBe(0);
    expect(parseIntEnv('1000000', 99, opts)).toBe(1000000);
  });

  it('returns fallback when value is undefined or empty', () => {
    expect(parseIntEnv(undefined, 99, opts)).toBe(99);
    expect(parseIntEnv('', 99, opts)).toBe(99);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseIntEnv('  42  ', 99, opts)).toBe(42);
  });

  it('throws on non-numeric string (NaN)', () => {
    expect(() => parseIntEnv('foo', 99, opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "foo")',
    );
  });

  it('throws on fractional value (Number.parseInt would silently truncate)', () => {
    expect(() => parseIntEnv('1.5', 99, opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "1.5")',
    );
    expect(() => parseIntEnv('0.0001', 99, opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "0.0001")',
    );
  });

  it('throws on scientific notation that yields fractional', () => {
    expect(() => parseIntEnv('1.5e0', 99, opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "1.5e0")',
    );
  });

  it('throws when value below min', () => {
    expect(() => parseIntEnv('-1', 99, { name: 'HIVE_TEST_X', min: 0 })).toThrow(
      'HIVE_TEST_X must be >= 0 (got -1)',
    );
  });

  it('throws when value above max', () => {
    expect(() => parseIntEnv('100', 99, { name: 'HIVE_TEST_X', min: 0, max: 50 })).toThrow(
      'HIVE_TEST_X must be <= 50 (got 100)',
    );
  });

  it('accepts negative integers when min permits', () => {
    expect(parseIntEnv('-5', 99, { name: 'HIVE_TEST_X', min: -10 })).toBe(-5);
  });

  it('does not enforce min/max when not set', () => {
    expect(parseIntEnv('-9999', 99, { name: 'HIVE_TEST_X' })).toBe(-9999);
    expect(parseIntEnv('999999999', 99, { name: 'HIVE_TEST_X' })).toBe(999999999);
  });

  it('throws on Infinity', () => {
    expect(() => parseIntEnv('Infinity', 99, opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "Infinity")',
    );
  });
});

describe('parseNullableIntEnv', () => {
  const opts = { name: 'HIVE_TEST_X', min: 0 };

  it('returns null when value is undefined, empty, or literal "null"', () => {
    expect(parseNullableIntEnv(undefined, opts)).toBeNull();
    expect(parseNullableIntEnv('', opts)).toBeNull();
    expect(parseNullableIntEnv('null', opts)).toBeNull();
  });

  it('returns parsed integer when value is well-formed', () => {
    expect(parseNullableIntEnv('42', opts)).toBe(42);
  });

  it('throws on fractional', () => {
    expect(() => parseNullableIntEnv('1.5', opts)).toThrow(
      'HIVE_TEST_X must be an integer (got "1.5")',
    );
  });

  it('throws when below min', () => {
    expect(() => parseNullableIntEnv('-1', { name: 'HIVE_TEST_X', min: 0 })).toThrow(
      'HIVE_TEST_X must be >= 0 (got -1)',
    );
  });
});

describe('parseBoolEnv', () => {
  const opts = { name: 'HIVE_TEST_X' };

  it('accepts case-insensitive true variants', () => {
    expect(parseBoolEnv('true', false, opts)).toBe(true);
    expect(parseBoolEnv('TRUE', false, opts)).toBe(true);
    expect(parseBoolEnv('True', false, opts)).toBe(true);
    expect(parseBoolEnv('1', false, opts)).toBe(true);
  });

  it('accepts case-insensitive false variants', () => {
    expect(parseBoolEnv('false', true, opts)).toBe(false);
    expect(parseBoolEnv('FALSE', true, opts)).toBe(false);
    expect(parseBoolEnv('False', true, opts)).toBe(false);
    expect(parseBoolEnv('0', true, opts)).toBe(false);
  });

  it('returns fallback when value is undefined or empty', () => {
    expect(parseBoolEnv(undefined, true, opts)).toBe(true);
    expect(parseBoolEnv(undefined, false, opts)).toBe(false);
    expect(parseBoolEnv('', true, opts)).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(parseBoolEnv('  true  ', false, opts)).toBe(true);
  });

  it('throws on unrecognized value', () => {
    expect(() => parseBoolEnv('yes', false, opts)).toThrow(
      "HIVE_TEST_X must be 'true' or 'false' (got \"yes\")",
    );
    expect(() => parseBoolEnv('2', false, opts)).toThrow(
      "HIVE_TEST_X must be 'true' or 'false' (got \"2\")",
    );
  });
});
