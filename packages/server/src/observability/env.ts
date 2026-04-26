// Shared env var parsing utilities. Used by composition factories and domain
// modules to read HIVE_* env vars with strict validation. Centralized to:
//   1. Reject fractionals — `Number.parseInt` silently truncates '1.5' → 1.
//   2. Provide consistent error messages naming the offending var.
//   3. Avoid duplication across factories (notifications, visibility, db, etc.).

export interface ParseIntOptions {
  name: string;
  min?: number;
  max?: number;
}

export interface ParseBoolOptions {
  name: string;
}

export function parseIntEnv(
  value: string | undefined,
  fallback: number,
  opts: ParseIntOptions,
): number {
  if (value === undefined || value === '') return fallback;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${opts.name} must be an integer (got ${JSON.stringify(value)})`);
  }
  if (opts.min !== undefined && parsed < opts.min) {
    throw new Error(`${opts.name} must be >= ${String(opts.min)} (got ${String(parsed)})`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`${opts.name} must be <= ${String(opts.max)} (got ${String(parsed)})`);
  }
  return parsed;
}

export function parseNullableIntEnv(
  value: string | undefined,
  opts: ParseIntOptions,
): number | null {
  if (value === undefined || value === '' || value === 'null') return null;
  return parseIntEnv(value, 0, opts);
}

export function parseBoolEnv(
  value: string | undefined,
  fallback: boolean,
  opts: ParseBoolOptions,
): boolean {
  if (value === undefined || value === '') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  throw new Error(`${opts.name} must be 'true' or 'false' (got ${JSON.stringify(value)})`);
}
