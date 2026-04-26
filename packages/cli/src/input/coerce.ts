// Safe coercion of commander's `unknown` option values to strings/arrays.
// commander types option values as `unknown` because the action signature
// receives `Record<string, unknown>`. Direct `String(x)` triggers the
// `no-base-to-string` lint when `x` could be an object. These helpers narrow
// before stringifying.

export function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Defensive: drop arrays / objects rather than rendering '[object Object]'.
  return undefined;
}

export function asString(value: unknown, fallback = ''): string {
  return asOptionalString(value) ?? fallback;
}

export function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const str = asOptionalString(value);
  if (str === undefined) return undefined;
  const parsed = Number.parseInt(str, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const s = asOptionalString(item);
    if (s !== undefined) out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}
