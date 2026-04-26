import { describe, expect, it } from 'vitest';

import { isUuidV7, parseUuidV7 } from './parse-uuid.js';

interface CliErrorLike {
  name: string;
  code: string;
  subCode?: string;
  message: string;
}

function isCliErrorLike(err: unknown): err is CliErrorLike {
  return err instanceof Error && err.name === 'CliError' && 'code' in err;
}

const VALID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100';
const VALID_UPPER = VALID.toUpperCase();
const VALID_V4 = '550e8400-e29b-41d4-a716-446655440000';
const NOT_UUID = 'not-a-uuid';

describe('isUuidV7', () => {
  it('accepts valid UUID v7 (lower)', () => {
    expect(isUuidV7(VALID)).toBe(true);
  });
  it('accepts valid UUID v7 (upper)', () => {
    expect(isUuidV7(VALID_UPPER)).toBe(true);
  });
  it('rejects v4', () => {
    expect(isUuidV7(VALID_V4)).toBe(false);
  });
  it('rejects garbage', () => {
    expect(isUuidV7(NOT_UUID)).toBe(false);
    expect(isUuidV7('')).toBe(false);
  });
});

describe('parseUuidV7', () => {
  it('returns lowercase canonical form', () => {
    expect(parseUuidV7(VALID_UPPER)).toBe(VALID);
  });
  it('trims whitespace', () => {
    expect(parseUuidV7(`  ${VALID}  `)).toBe(VALID);
  });
  it('throws CliError for v4', () => {
    expect(() => parseUuidV7(VALID_V4)).toThrow(/not a valid UUID v7/);
  });
  it('error message includes field name', () => {
    try {
      parseUuidV7(NOT_UUID, 'agent-id');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCliErrorLike(err)).toBe(true);
      if (isCliErrorLike(err)) {
        expect(err.message).toMatch(/agent-id/);
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.subCode).toBe('uuid_invalid');
      }
    }
  });
});
