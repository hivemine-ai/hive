import { describe, expect, it } from 'vitest';

import { CellError, isCellError } from './errors.js';

describe('CellError', () => {
  it('preserves the code in the field', () => {
    const err = new CellError('RECIPIENT_UNREACHABLE');
    expect(err.code).toBe('RECIPIENT_UNREACHABLE');
    expect(err.subCode).toBeUndefined();
  });

  it('preserves the subCode when given', () => {
    const err = new CellError('INVALID_INPUT', { subCode: 'body_too_large' });
    expect(err.subCode).toBe('body_too_large');
  });

  it('uses code as the default message and includes subCode when present', () => {
    const a = new CellError('INSUFFICIENT_PRIVILEGE');
    expect(a.message).toBe('INSUFFICIENT_PRIVILEGE');
    const b = new CellError('RECIPIENT_UNREACHABLE', { subCode: 'cell_closed_or_missing' });
    expect(b.message).toBe('RECIPIENT_UNREACHABLE (cell_closed_or_missing)');
  });

  it('honors a custom message override', () => {
    const err = new CellError('INVALID_INPUT', {
      subCode: 'ttl_invalid',
      message: 'TTL must be > 0',
    });
    expect(err.message).toBe('TTL must be > 0');
  });

  it('chains the underlying cause', () => {
    const cause = new Error('underlying SQL violation');
    const err = new CellError('INTERNAL_INCONSISTENCY', { cause });
    expect(err.cause).toBe(cause);
  });

  it('is named "CellError"', () => {
    expect(new CellError('RECIPIENT_UNREACHABLE').name).toBe('CellError');
  });

  it('isCellError narrows correctly', () => {
    const err: unknown = new CellError('INVALID_INPUT');
    expect(isCellError(err)).toBe(true);
    expect(isCellError(new Error('plain'))).toBe(false);
    expect(isCellError('string')).toBe(false);
  });
});
