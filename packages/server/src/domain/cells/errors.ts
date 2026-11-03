// Domain error codes for the Cell Store subsystem. Mirrors the auth/errors.ts shape
// per the "Mapping de errores" section of the Cell Store + Message Persistence tech spec.
//
// Subcode catalog (informative — kept as `string` for forward compatibility):
//   RECIPIENT_UNREACHABLE: 'cell_closed_or_missing' | 'visibility_denied'
//   INVALID_INPUT: 'body_too_large' | 'ttl_invalid' | 'ttl_in_past' | 'type_unknown'
//                  | 'reply_to_malformed' | 'idempotency_key_too_long' | 'action_too_large'
//                  | 'action_too_deep'
//   INSUFFICIENT_PRIVILEGE: 'not_admin' | 'override_ownership_violation' | 'policy_not_visible'
//   INTERNAL_INCONSISTENCY: (free-form context string, e.g. 'caller_without_cell')

export type CellErrorCode =
  | 'RECIPIENT_UNREACHABLE'
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_PRIVILEGE'
  | 'SENDER_QUOTA_EXCEEDED'
  | 'INTERNAL_INCONSISTENCY';

export interface CellErrorOptions {
  subCode?: string;
  message?: string;
  cause?: unknown;
  /** Plain JSON copied to `error.data` on the wire. Never carries a subCode or third-party data. */
  data?: Record<string, unknown>;
}

export class CellError extends Error {
  readonly code: CellErrorCode;
  readonly subCode: string | undefined;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: CellErrorCode, options: CellErrorOptions = {}) {
    const baseMessage =
      options.message ?? (options.subCode !== undefined ? `${code} (${options.subCode})` : code);
    super(baseMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CellError';
    this.code = code;
    this.subCode = options.subCode;
    this.data = options.data;
  }
}

export function isCellError(err: unknown): err is CellError {
  return err instanceof CellError;
}
