// Waggle errors — sparse by construction. The subsystem is a notifier, not a
// privilege gate, so almost every failure path logs and continues. Only
// `subscribe()` exposes synchronous errors to the MCP transport caller.
//
// Convention inherited from Auth + Identity: `subCode` lives in logs/audit and
// is NEVER serialized to the wire (privacy uniformity). The `code` is what
// becomes the MCP JSON-RPC error code.

export type WaggleErrorCode = 'PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE' | 'INVALID_INPUT';

export interface WaggleErrorOptions {
  subCode?: string;
  message?: string;
  cause?: unknown;
}

export class WaggleError extends Error {
  readonly code: WaggleErrorCode;
  readonly subCode: string | undefined;

  constructor(code: WaggleErrorCode, options: WaggleErrorOptions = {}) {
    super(options.message ?? code);
    this.name = 'WaggleError';
    this.code = code;
    this.subCode = options.subCode;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isWaggleError(value: unknown): value is WaggleError {
  return value instanceof WaggleError;
}
