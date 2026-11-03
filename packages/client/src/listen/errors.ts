// Typed failures of the listen library. The CLI maps `kind` to its own error codes.

export type ListenErrorKind =
  /** The server rejected the credential (`-32001`, HTTP 401). */
  | 'auth_rejected'
  /** The server does not serve revision 2026-07-28 (`-32022`). Not recoverable. */
  | 'protocol_unsupported'
  /** Anything else: network failure, timeout, unexpected response. */
  | 'transport';

export class ListenError extends Error {
  readonly kind: ListenErrorKind;

  constructor(kind: ListenErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ListenError';
    this.kind = kind;
  }
}

export function isListenError(err: unknown): err is ListenError {
  return err instanceof ListenError;
}
