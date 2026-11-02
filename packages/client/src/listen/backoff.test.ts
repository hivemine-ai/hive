import { describe, expect, it } from 'vitest';

import { AuthRetryWindow, DEFAULT_BACKOFF, backoffDelay } from './backoff.js';

describe('backoffDelay', () => {
  const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };

  it('starts at the minimum and doubles each attempt', () => {
    expect(backoffDelay(0, noJitter, () => 0.5)).toBe(noJitter.minMs);
    expect(backoffDelay(1, noJitter, () => 0.5)).toBe(noJitter.minMs * 2);
    expect(backoffDelay(2, noJitter, () => 0.5)).toBe(noJitter.minMs * 4);
  });

  it('never exceeds the maximum', () => {
    expect(backoffDelay(50, noJitter, () => 0.5)).toBe(noJitter.maxMs);
  });

  it('applies symmetric jitter within the configured ratio', () => {
    const opts = { minMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.2 };
    expect(backoffDelay(0, opts, () => 0)).toBe(800);
    expect(backoffDelay(0, opts, () => 1)).toBe(1200);
    expect(backoffDelay(0, opts, () => 0.5)).toBe(1000);
  });

  it('keeps the jittered delay under the maximum', () => {
    const opts = { minMs: 1000, maxMs: 4000, factor: 2, jitter: 0.5 };
    expect(backoffDelay(10, opts, () => 1)).toBeLessThanOrEqual(4000);
  });
});

describe('AuthRetryWindow', () => {
  it('keeps retrying until the window since the first rejection is spent', () => {
    let now = 1_000;
    const win = new AuthRetryWindow(300_000, () => now);
    expect(win.reject()).toEqual({ giveUp: false, remainingMs: 300_000 });
    now += 100_000;
    expect(win.reject()).toEqual({ giveUp: false, remainingMs: 200_000 });
    now += 200_000;
    expect(win.reject().giveUp).toBe(true);
  });

  it('restarts the window after a success', () => {
    let now = 0;
    const win = new AuthRetryWindow(60_000, () => now);
    win.reject();
    now += 50_000;
    win.success();
    now += 50_000;
    expect(win.reject()).toEqual({ giveUp: false, remainingMs: 60_000 });
  });

  it('gives up at once with a zero window', () => {
    const win = new AuthRetryWindow(0, () => 5);
    expect(win.reject().giveUp).toBe(true);
  });
});
