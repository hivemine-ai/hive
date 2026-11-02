// Exponential backoff with jitter, and the bounded retry window used when the
// server keeps rejecting the credential.

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
  factor: number;
  /** Symmetric jitter ratio, 0.2 meaning +-20% of the delay. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  minMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

/** Delay before retry number `attempt` (0-based). `random` returns a value in [0, 1]. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number,
): number {
  const base = Math.min(options.minMs * options.factor ** attempt, options.maxMs);
  const spread = base * options.jitter * (random() * 2 - 1);
  return Math.min(Math.round(base + spread), options.maxMs);
}

export interface AuthRejection {
  giveUp: boolean;
  /** Time left in the window, measured from the first rejection of the streak. */
  remainingMs: number;
}

/**
 * Tracks a streak of continuous auth rejections. The window runs from the first
 * rejection and restarts after any authenticated success.
 */
export class AuthRetryWindow {
  private startedAt: number | undefined;

  constructor(
    private readonly maxMs: number,
    private readonly now: () => number,
  ) {}

  reject(): AuthRejection {
    const now = this.now();
    this.startedAt ??= now;
    const remainingMs = Math.max(0, this.startedAt + this.maxMs - now);
    return { giveUp: remainingMs === 0, remainingMs };
  }

  success(): void {
    this.startedAt = undefined;
  }
}
