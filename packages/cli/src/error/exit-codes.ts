// Exit code constants per the hivectl + Admin Operations tech spec § "Mapping de errores".
// Constants instead of magic numbers; published for both handlers and tests.

export const EXIT_OK = 0;
/** Bad input, unparseable args, validation failure. */
export const EXIT_USER_ERROR = 1;
/** Unhandled exceptions, DB errors, filesystem failures. */
export const EXIT_INTERNAL = 2;
/** Entity (Hivekeeper / Agent / Credential / etc.) not found. */
export const EXIT_NOT_FOUND = 3;
/** Entity exists but operation rejected (already revoked, last admin invariant, etc.). */
export const EXIT_PRECONDITION = 4;
/** `--operator-id` provided but not an active admin. */
export const EXIT_PERMISSION = 5;
/** SIGINT / SIGTERM cancelled the operation. Convention: 128 + signal. */
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_USER_ERROR
  | typeof EXIT_INTERNAL
  | typeof EXIT_NOT_FOUND
  | typeof EXIT_PRECONDITION
  | typeof EXIT_PERMISSION
  | typeof EXIT_INTERRUPTED;
