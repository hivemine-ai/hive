// CLI-specific errors raised before reaching domain functions.
// Mapped to exit codes by handler.ts.

export type CliErrorCode =
  | 'HIVE_NOT_INITIALIZED'
  | 'HIVE_ALREADY_INITIALIZED'
  | 'OPERATOR_ID_INVALID'
  | 'OPERATOR_ID_NOT_ADMIN'
  | 'CONFIRMATION_DECLINED'
  | 'INTERRUPTED'
  | 'CONFIG_INVALID';

export interface CliErrorOptions {
  subCode?: string;
  message?: string;
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly subCode: string | undefined;

  constructor(code: CliErrorCode, opts: CliErrorOptions = {}) {
    const baseMessage = opts.message ?? `${code}${opts.subCode ? ` (${opts.subCode})` : ''}`;
    super(baseMessage);
    this.name = 'CliError';
    this.code = code;
    this.subCode = opts.subCode;
  }
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}
