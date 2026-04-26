import { AuthError } from '@hive/server';
import { describe, expect, it } from 'vitest';

import { CliError } from './cli-error.js';
import { mapErrorToExit } from './handler.js';
import {
  EXIT_INTERNAL,
  EXIT_INTERRUPTED,
  EXIT_NOT_FOUND,
  EXIT_PERMISSION,
  EXIT_PRECONDITION,
  EXIT_USER_ERROR,
} from './exit-codes.js';

describe('mapErrorToExit', () => {
  describe('CliError', () => {
    it('HIVE_NOT_INITIALIZED → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new CliError('HIVE_NOT_INITIALIZED')).code).toBe(EXIT_PRECONDITION);
    });
    it('HIVE_ALREADY_INITIALIZED → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new CliError('HIVE_ALREADY_INITIALIZED')).code).toBe(EXIT_PRECONDITION);
    });
    it('OPERATOR_ID_INVALID → EXIT_USER_ERROR', () => {
      expect(mapErrorToExit(new CliError('OPERATOR_ID_INVALID')).code).toBe(EXIT_USER_ERROR);
    });
    it('OPERATOR_ID_NOT_ADMIN → EXIT_PERMISSION', () => {
      const m = mapErrorToExit(new CliError('OPERATOR_ID_NOT_ADMIN', { subCode: 'not_admin' }));
      expect(m.code).toBe(EXIT_PERMISSION);
      expect(m.message).toMatch(/not_admin/);
    });
    it('CONFIRMATION_DECLINED → EXIT_USER_ERROR', () => {
      expect(mapErrorToExit(new CliError('CONFIRMATION_DECLINED')).code).toBe(EXIT_USER_ERROR);
    });
    it('INTERRUPTED → EXIT_INTERRUPTED (130)', () => {
      expect(mapErrorToExit(new CliError('INTERRUPTED')).code).toBe(EXIT_INTERRUPTED);
    });
    it('CONFIG_INVALID → EXIT_USER_ERROR', () => {
      expect(mapErrorToExit(new CliError('CONFIG_INVALID')).code).toBe(EXIT_USER_ERROR);
    });
  });

  describe('AuthError', () => {
    it('PARTICIPANT_NOT_FOUND → EXIT_NOT_FOUND', () => {
      expect(mapErrorToExit(new AuthError('PARTICIPANT_NOT_FOUND')).code).toBe(EXIT_NOT_FOUND);
    });
    it('PARTICIPANT_NOT_FOUND_FOR_ISSUE → EXIT_NOT_FOUND', () => {
      expect(mapErrorToExit(new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE')).code).toBe(
        EXIT_NOT_FOUND,
      );
    });
    it('PARTICIPANT_NOT_ACTIVE → EXIT_PRECONDITION (renders subCode)', () => {
      const m = mapErrorToExit(new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: 'revoked' }));
      expect(m.code).toBe(EXIT_PRECONDITION);
      expect(m.message).toMatch(/revoked/);
    });
    it('CREDENTIAL_ALREADY_REVOKED → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new AuthError('CREDENTIAL_ALREADY_REVOKED')).code).toBe(
        EXIT_PRECONDITION,
      );
    });
    it('LAST_ADMIN_INVARIANT → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new AuthError('LAST_ADMIN_INVARIANT')).code).toBe(EXIT_PRECONDITION);
    });
    it('INVALID_STATE_TRANSITION → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new AuthError('INVALID_STATE_TRANSITION')).code).toBe(
        EXIT_PRECONDITION,
      );
    });
    it('INSUFFICIENT_PRIVILEGE → EXIT_PERMISSION', () => {
      expect(mapErrorToExit(new AuthError('INSUFFICIENT_PRIVILEGE')).code).toBe(EXIT_PERMISSION);
    });
    it('HIVE_ALREADY_INITIALIZED (from auth) → EXIT_PRECONDITION', () => {
      expect(mapErrorToExit(new AuthError('HIVE_ALREADY_INITIALIZED')).code).toBe(
        EXIT_PRECONDITION,
      );
    });
  });

  describe('plain Error and unknown', () => {
    it('plain Error → EXIT_INTERNAL', () => {
      const m = mapErrorToExit(new Error('boom'));
      expect(m.code).toBe(EXIT_INTERNAL);
      expect(m.message).toMatch(/boom/);
    });
    it('non-Error value → EXIT_INTERNAL', () => {
      const m = mapErrorToExit('string error');
      expect(m.code).toBe(EXIT_INTERNAL);
      expect(m.message).toMatch(/string error/);
    });
  });
});
