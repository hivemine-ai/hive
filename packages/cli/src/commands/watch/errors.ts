// Error codes of `hivectl watch`, per the hivectl + Admin Operations tech spec
// § "Mapping de errores". `watch` maps its own errors instead of going through
// the domain error handler: it is a network client with no domain layer.

import { isListenError } from '@hive/client';

import { EXIT_INTERNAL, EXIT_PRECONDITION, EXIT_USER_ERROR } from '#error/exit-codes.js';
import type { ExitCode } from '#error/exit-codes.js';

export type WatchErrorCode =
  | 'WATCH_SERVER_URL_MISSING'
  | 'WATCH_INVALID_OPTION'
  | 'WATCH_CREDENTIAL_MISSING'
  | 'WATCH_CREDENTIAL_INSECURE_PERMS'
  | 'WATCH_CREDENTIAL_REJECTED'
  | 'WATCH_PROTOCOL_UNSUPPORTED'
  | 'WATCH_EXEC_FAILED'
  | 'WATCH_ONCE_EXEC_CONFLICT'
  | 'WATCH_ONCE_FAILED'
  | 'WATCH_SESSION_NAME_IN_USE'
  | 'WATCH_SESSION_REGISTER_REJECTED'
  | 'WATCH_STATE_FILE_INSECURE'
  | 'WATCH_ATTACH_TARGET_NOT_FOUND';

const EXIT_BY_CODE: Record<WatchErrorCode, ExitCode> = {
  WATCH_SERVER_URL_MISSING: EXIT_USER_ERROR,
  WATCH_INVALID_OPTION: EXIT_USER_ERROR,
  WATCH_CREDENTIAL_MISSING: EXIT_USER_ERROR,
  WATCH_CREDENTIAL_INSECURE_PERMS: EXIT_PRECONDITION,
  WATCH_CREDENTIAL_REJECTED: EXIT_PRECONDITION,
  WATCH_PROTOCOL_UNSUPPORTED: EXIT_PRECONDITION,
  WATCH_EXEC_FAILED: EXIT_INTERNAL,
  WATCH_ONCE_EXEC_CONFLICT: EXIT_USER_ERROR,
  WATCH_ONCE_FAILED: EXIT_INTERNAL,
  WATCH_SESSION_NAME_IN_USE: EXIT_PRECONDITION,
  WATCH_SESSION_REGISTER_REJECTED: EXIT_PRECONDITION,
  WATCH_STATE_FILE_INSECURE: EXIT_PRECONDITION,
  WATCH_ATTACH_TARGET_NOT_FOUND: EXIT_USER_ERROR,
};

export class WatchError extends Error {
  readonly code: WatchErrorCode;

  constructor(code: WatchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WatchError';
    this.code = code;
  }
}

export function isWatchError(err: unknown): err is WatchError {
  return err instanceof WatchError;
}

export interface WatchExit {
  code: ExitCode;
  /** One line for stderr. Starts with the `WATCH_*` code so supervisors can parse it. */
  message: string;
}

/** Maps a thrown error to an exit code and a stderr line. */
export function mapWatchError(err: unknown): WatchExit {
  if (isWatchError(err)) {
    return { code: EXIT_BY_CODE[err.code], message: `${err.code}: ${err.message}` };
  }
  if (isListenError(err) && err.kind === 'protocol_unsupported') {
    return {
      code: EXIT_PRECONDITION,
      message: `WATCH_PROTOCOL_UNSUPPORTED: ${err.message}`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: EXIT_INTERNAL, message: `internal error: ${message}` };
}
