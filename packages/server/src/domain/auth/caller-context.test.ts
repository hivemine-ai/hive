import { describe, expect, it } from 'vitest';

import { requireAdminCaller } from './caller-context.js';
import type { CallerContext } from './caller-context.js';
import { isAuthError } from './errors.js';
import type { AuthError } from './errors.js';
import type { CurrentParticipantState, IdentityContext } from './types.js';

function makeIdentity(overrides: {
  kind: 'hivekeeper' | 'worker' | 'scout';
  isAdmin?: boolean;
}): IdentityContext {
  const current: CurrentParticipantState =
    overrides.isAdmin === undefined
      ? { state: 'active' }
      : { state: 'active', isAdmin: overrides.isAdmin };
  return {
    participantId: '01900000-0000-7000-8000-000000000001',
    kind: overrides.kind,
    hiveId: '01900000-0000-7000-8000-0000000000aa',
    colonyId: '01900000-0000-7000-8000-0000000000bb',
    snapshot: {
      issuedAt: new Date('2026-04-25T12:00:00Z'),
      credentialJti: '01900000-0000-7000-8000-0000000000cc',
      credentialKid: 'a'.repeat(32),
    },
    current,
  };
}

describe('requireAdminCaller', () => {
  it('returns the identity when authenticated and admin', () => {
    const identity = makeIdentity({ kind: 'hivekeeper', isAdmin: true });
    const caller: CallerContext = { kind: 'authenticated', identity };
    expect(requireAdminCaller(caller)).toBe(identity);
  });

  it('returns null when caller is system (trust anchor)', () => {
    const caller: CallerContext = {
      kind: 'system',
      osUser: 'leonardo',
      operatorNote: 'hivectl init',
    };
    expect(requireAdminCaller(caller)).toBeNull();
  });

  it('throws INSUFFICIENT_PRIVILEGE (subCode not_admin) for hivekeeper without admin', () => {
    const identity = makeIdentity({ kind: 'hivekeeper', isAdmin: false });
    const caller: CallerContext = { kind: 'authenticated', identity };
    try {
      requireAdminCaller(caller);
      expect.fail('expected throw');
    } catch (err) {
      expect(isAuthError(err)).toBe(true);
      const e = err as AuthError;
      expect(e.code).toBe('INSUFFICIENT_PRIVILEGE');
      expect(e.subCode).toBe('not_admin');
    }
  });

  it('throws INSUFFICIENT_PRIVILEGE (subCode not_hivekeeper) for worker', () => {
    const identity = makeIdentity({ kind: 'worker' });
    const caller: CallerContext = { kind: 'authenticated', identity };
    try {
      requireAdminCaller(caller);
      expect.fail('expected throw');
    } catch (err) {
      const e = err as AuthError;
      expect(e.code).toBe('INSUFFICIENT_PRIVILEGE');
      expect(e.subCode).toBe('not_hivekeeper');
    }
  });

  it('throws INSUFFICIENT_PRIVILEGE for scout (also not_hivekeeper)', () => {
    const identity = makeIdentity({ kind: 'scout' });
    const caller: CallerContext = { kind: 'authenticated', identity };
    try {
      requireAdminCaller(caller);
      expect.fail('expected throw');
    } catch (err) {
      const e = err as AuthError;
      expect(e.subCode).toBe('not_hivekeeper');
    }
  });
});
