// Parse duration strings like "30d", "12h", "365d", "5m" → milliseconds.
// Supported suffixes: ms, s, m, h, d. No suffix = ms. Negative or zero = throw.

import { CliError } from '../error/cli-error.js';

const PATTERN = /^(\d+)(ms|s|m|h|d)?$/;

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = PATTERN.exec(trimmed);
  if (!match) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'duration_invalid',
      message: `cannot parse duration '${input}'; expected like '30d', '12h', '5m', '500ms'`,
    });
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'duration_invalid',
      message: `duration must be positive, got '${input}'`,
    });
  }
  const unit = match[2] ?? 'ms';
  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default: {
      const exhaustive: never = unit as never;
      throw new CliError('CONFIG_INVALID', {
        subCode: 'duration_invalid',
        message: `unsupported duration unit '${String(exhaustive)}'`,
      });
    }
  }
}
