// Type mappers for the persistence layer.
// Per ADR-008: timestamps stored as ISO 8601 text, JSON payloads as text with app-level validation,
// booleans as INTEGER 0/1 for SQLite compatibility.

export function dateToIso(d: Date): string {
  return d.toISOString();
}

export function isoToDate(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
  }
  return d;
}

export function jsonStringify<T>(value: T): string {
  return JSON.stringify(value);
}

export function jsonParse<T>(text: string): T {
  return JSON.parse(text) as T;
}

export interface ValidateJsonTextOptions {
  maxBytes: number;
}

/**
 * Validates that a serialized JSON text does not exceed a byte budget.
 * Throws if the limit is exceeded; the caller maps the error to a domain code.
 */
export function validateJsonText(text: string, opts: ValidateJsonTextOptions): void {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > opts.maxBytes) {
    throw new Error(`JSON payload exceeds limit: ${byteLength} bytes > ${opts.maxBytes} bytes`);
  }
}

export function boolToInt(b: boolean): 0 | 1 {
  return b ? 1 : 0;
}

export function intToBool(n: number): boolean {
  return n !== 0;
}
