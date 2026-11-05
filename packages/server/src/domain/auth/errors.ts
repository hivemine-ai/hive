// Domain error codes for the auth subsystem. The values are the canonical
// error vocabulary mapped to wire codes by the transport layer (per the
// "Mapping de errores" section of the Auth + Identity tech spec).

export type AuthErrorCode =
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_INAUTHENTIC'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_NOT_YET_VALID'
  | 'CREDENTIAL_REVOKED'
  | 'PARTICIPANT_NOT_FOUND'
  | 'PARTICIPANT_NOT_ACTIVE'
  | 'INSUFFICIENT_PRIVILEGE'
  | 'CREDENTIAL_ALREADY_REVOKED'
  | 'PARTICIPANT_NOT_FOUND_FOR_ISSUE'
  | 'LAST_ADMIN_INVARIANT'
  | 'INVALID_STATE_TRANSITION'
  | 'HIVE_ALREADY_INITIALIZED'
  | 'INVALID_INPUT'
  | 'NAME_IN_USE'
  | 'NAME_TAKEN'
  | 'AGENT_SUSPENDED'
  | 'ENROLLMENT_QUOTA_EXCEEDED';

export interface AuthErrorOptions {
  subCode?: string;
  message?: string;
  cause?: unknown;
  // ENROLLMENT_QUOTA_EXCEEDED: the quota that was hit, for the wire `error.data`.
  limit?: number;
}

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly subCode: string | undefined;
  readonly limit: number | undefined;

  constructor(code: AuthErrorCode, options: AuthErrorOptions = {}) {
    const baseMessage =
      options.message ?? (options.subCode !== undefined ? `${code} (${options.subCode})` : code);
    super(baseMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AuthError';
    this.code = code;
    this.subCode = options.subCode;
    this.limit = options.limit;
  }
}

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}
