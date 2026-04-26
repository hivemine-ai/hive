import { describe, expect, it } from 'vitest';

import {
  asBoolean,
  asOptionalNumber,
  asOptionalString,
  asString,
  asStringArray,
} from './coerce.js';

describe('asOptionalString', () => {
  it('returns undefined for null/undefined', () => {
    expect(asOptionalString(undefined)).toBeUndefined();
    expect(asOptionalString(null)).toBeUndefined();
  });
  it('returns the string as-is', () => {
    expect(asOptionalString('hello')).toBe('hello');
  });
  it('coerces numbers and booleans', () => {
    expect(asOptionalString(42)).toBe('42');
    expect(asOptionalString(true)).toBe('true');
    expect(asOptionalString(false)).toBe('false');
  });
  it('drops objects/arrays defensively', () => {
    expect(asOptionalString({ a: 1 })).toBeUndefined();
    expect(asOptionalString([1, 2])).toBeUndefined();
  });
});

describe('asString', () => {
  it('falls back when undefined', () => {
    expect(asString(undefined, 'fallback')).toBe('fallback');
    expect(asString(null, 'fallback')).toBe('fallback');
  });
  it('uses empty fallback by default', () => {
    expect(asString(undefined)).toBe('');
  });
});

describe('asOptionalNumber', () => {
  it('parses integer strings', () => {
    expect(asOptionalNumber('42')).toBe(42);
    expect(asOptionalNumber('100')).toBe(100);
  });
  it('returns undefined for empty/null', () => {
    expect(asOptionalNumber(undefined)).toBeUndefined();
    expect(asOptionalNumber('')).toBeUndefined();
    expect(asOptionalNumber('abc')).toBeUndefined();
  });
  it('coerces numeric values directly', () => {
    expect(asOptionalNumber(42)).toBe(42);
  });
});

describe('asStringArray', () => {
  it('returns undefined for non-array', () => {
    expect(asStringArray(undefined)).toBeUndefined();
    expect(asStringArray('not array')).toBeUndefined();
  });
  it('returns undefined for empty array', () => {
    expect(asStringArray([])).toBeUndefined();
  });
  it('preserves string items', () => {
    expect(asStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('drops object items defensively', () => {
    expect(asStringArray(['ok', { x: 1 }])).toEqual(['ok']);
  });
});

describe('asBoolean', () => {
  it('true only for true literal', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean('true')).toBe(false);
    expect(asBoolean(1)).toBe(false);
    expect(asBoolean(undefined)).toBe(false);
  });
});
