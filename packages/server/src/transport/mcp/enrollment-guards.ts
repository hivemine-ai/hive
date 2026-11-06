// In-memory guards of register_session (ADR-026). Both are fixed windows per process:
// Hive is mono-process (ADR-003), and losing them on a restart is accepted. Expired
// entries are dropped when their key comes back, and the maps are swept once they grow,
// so their size stays bounded by the keys active in one window.

const SWEEP_THRESHOLD = 1024;

interface Window {
  startMs: number;
  count: number;
}

function sweep(windows: Map<string, Window>, nowMs: number, windowMs: number): void {
  if (windows.size < SWEEP_THRESHOLD) return;
  for (const [key, window] of windows) {
    if (nowMs - window.startMs >= windowMs) windows.delete(key);
  }
}

function hitWindow(windows: Map<string, Window>, key: string, nowMs: number, windowMs: number) {
  const current = windows.get(key);
  if (current !== undefined && nowMs - current.startMs < windowMs) {
    current.count += 1;
    return current;
  }
  sweep(windows, nowMs, windowMs);
  const fresh = { startMs: nowMs, count: 1 };
  windows.set(key, fresh);
  return fresh;
}

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RegisterRateLimiter {
  /** Counts one call under `key` (enrollment jti, or Agent id on a renewal). */
  hit(key: string): RateLimitVerdict;
}

export interface RegisterRateLimiterOptions {
  /** HIVE_ENROLLMENT_REGISTER_RATE_LIMIT. 0 disables the limiter. */
  limit: number;
  /** HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS. */
  windowSeconds: number;
  now?: () => Date;
}

export function createRegisterRateLimiter(
  options: RegisterRateLimiterOptions,
): RegisterRateLimiter {
  const now = options.now ?? (() => new Date());
  const windowMs = options.windowSeconds * 1000;
  const windows = new Map<string, Window>();

  return {
    hit(key) {
      if (options.limit <= 0) return { allowed: true };
      const nowMs = now().getTime();
      const window = hitWindow(windows, key, nowMs, windowMs);
      if (window.count <= options.limit) return { allowed: true };
      const leftMs = window.startMs + windowMs - nowMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(leftMs / 1000)) };
    },
  };
}

export type RejectAlertVerdict = { alert: false } | { alert: true; rejections: number };

export interface RejectAlertCounter {
  /** Counts one domain rejection of `name` for `ownerId`; alerts once per window. */
  record(ownerId: string, name: string): RejectAlertVerdict;
}

export interface RejectAlertCounterOptions {
  /** HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD. 0 disables the alert. */
  threshold: number;
  /** HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES. */
  windowMinutes: number;
  now?: () => Date;
}

export function createRejectAlertCounter(options: RejectAlertCounterOptions): RejectAlertCounter {
  const now = options.now ?? (() => new Date());
  const windowMs = options.windowMinutes * 60_000;
  const windows = new Map<string, Window>();

  return {
    record(ownerId, name) {
      if (options.threshold <= 0) return { alert: false };
      const window = hitWindow(windows, `${ownerId}\u0000${name}`, now().getTime(), windowMs);
      if (window.count === options.threshold) return { alert: true, rejections: window.count };
      return { alert: false };
    },
  };
}
