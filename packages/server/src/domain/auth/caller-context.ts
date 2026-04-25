// CallerContext discriminated union and admin-check helper.
// Per ADR-007: every admin operation receives `caller: CallerContext` instead of a plain
// participant id. Domain invariants (LAST_ADMIN_INVARIANT, etc.) are enforced ALWAYS,
// regardless of the caller kind — `kind: 'system'` only skips the admin-flag check on the
// caller, NOT the integrity guarantees of the system.

import { AuthError } from './errors.js';
import type { IdentityContext } from './types.js';

export type CallerContext =
  | {
      kind: 'authenticated';
      identity: IdentityContext;
    }
  | {
      kind: 'system';
      // Operator OS user (read from process.env.USER in hivectl). For audit forensics.
      osUser?: string;
      // Free-form note from --operator-note CLI flag. Goes to audit_log.detail.
      operatorNote?: string;
    };

/**
 * If the caller is authenticated and admin, returns the IdentityContext.
 * If authenticated but not admin, throws AuthError(INSUFFICIENT_PRIVILEGE).
 * If system, returns null (the caller is implicitly trusted via shell access).
 *
 * Domain invariants must still be enforced by the calling function.
 */
export function requireAdminCaller(caller: CallerContext): IdentityContext | null {
  if (caller.kind === 'system') return null;

  if (caller.identity.current.isAdmin === true) {
    return caller.identity;
  }

  // The caller is authenticated but not admin — could be a Hivekeeper without admin flag,
  // or an Agent (Worker/Scout). Differentiate via subCode for logs/audit.
  const subCode = caller.identity.kind === 'hivekeeper' ? 'not_admin' : 'not_hivekeeper';
  throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode });
}
