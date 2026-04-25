import { describe, expect, it } from 'vitest';

import { AuthError, isAuthError } from './errors.js';

describe('AuthError', () => {
  it('preserves the code in the field', () => {
    const err = new AuthError('CREDENTIAL_REVOKED');
    expect(err.code).toBe('CREDENTIAL_REVOKED');
    expect(err.subCode).toBeUndefined();
  });

  it('preserves the subCode when given', () => {
    const err = new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: 'revoked' });
    expect(err.subCode).toBe('revoked');
  });

  it('uses code as the default message and includes subCode when present', () => {
    const a = new AuthError('CREDENTIAL_EXPIRED');
    expect(a.message).toBe('CREDENTIAL_EXPIRED');
    const b = new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'signature' });
    expect(b.message).toBe('CREDENTIAL_INAUTHENTIC (signature)');
  });

  it('honors a custom message override', () => {
    const err = new AuthError('CREDENTIAL_MISSING', {
      message: 'Bearer header absent',
    });
    expect(err.message).toBe('Bearer header absent');
  });

  it('chains the underlying cause', () => {
    const cause = new Error('jose threw JWTExpired');
    const err = new AuthError('CREDENTIAL_EXPIRED', { cause });
    expect(err.cause).toBe(cause);
  });

  it('is named "AuthError"', () => {
    expect(new AuthError('CREDENTIAL_MISSING').name).toBe('AuthError');
  });

  it('isAuthError narrows correctly', () => {
    const err: unknown = new AuthError('CREDENTIAL_MISSING');
    expect(isAuthError(err)).toBe(true);
    expect(isAuthError(new Error('plain'))).toBe(false);
    expect(isAuthError('string')).toBe(false);
  });
});
