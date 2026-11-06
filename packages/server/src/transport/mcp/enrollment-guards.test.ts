import { describe, expect, it } from 'vitest';

import { createRegisterRateLimiter, createRejectAlertCounter } from './enrollment-guards.js';

function clock(startMs = Date.parse('2026-11-06T12:00:00.000Z')) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('createRegisterRateLimiter (fixed window per key)', () => {
  it('admits up to the limit in a window, then answers the seconds left', () => {
    const c = clock();
    const limiter = createRegisterRateLimiter({ limit: 2, windowSeconds: 60, now: c.now });

    expect(limiter.hit('jti-1')).toEqual({ allowed: true });
    expect(limiter.hit('jti-1')).toEqual({ allowed: true });
    c.advance(20_500);
    expect(limiter.hit('jti-1')).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it('counts each key on its own', () => {
    const limiter = createRegisterRateLimiter({ limit: 1, windowSeconds: 60, now: clock().now });

    expect(limiter.hit('jti-1').allowed).toBe(true);
    expect(limiter.hit('agent-1').allowed).toBe(true);
    expect(limiter.hit('jti-1').allowed).toBe(false);
  });

  it('opens a new window once the previous one ended', () => {
    const c = clock();
    const limiter = createRegisterRateLimiter({ limit: 1, windowSeconds: 60, now: c.now });
    limiter.hit('jti-1');

    c.advance(60_000);

    expect(limiter.hit('jti-1')).toEqual({ allowed: true });
  });

  it('a limit of 0 disables the limiter', () => {
    const limiter = createRegisterRateLimiter({ limit: 0, windowSeconds: 60, now: clock().now });

    for (let i = 0; i < 100; i += 1) expect(limiter.hit('jti-1').allowed).toBe(true);
  });

  it('never answers a Retry-After below 1 second', () => {
    const c = clock();
    const limiter = createRegisterRateLimiter({ limit: 1, windowSeconds: 60, now: c.now });
    limiter.hit('jti-1');
    c.advance(59_999);

    expect(limiter.hit('jti-1')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe('createRejectAlertCounter (fixed window per owner and name)', () => {
  it('alerts once when the threshold is reached, not before and not again in the window', () => {
    const c = clock();
    const counter = createRejectAlertCounter({ threshold: 3, windowMinutes: 10, now: c.now });

    expect(counter.record('owner', 'claude-api')).toEqual({ alert: false });
    expect(counter.record('owner', 'claude-api')).toEqual({ alert: false });
    expect(counter.record('owner', 'claude-api')).toEqual({ alert: true, rejections: 3 });
    expect(counter.record('owner', 'claude-api')).toEqual({ alert: false });
  });

  it('keys by owner and name', () => {
    const counter = createRejectAlertCounter({ threshold: 2, windowMinutes: 10, now: clock().now });

    counter.record('owner', 'a');
    counter.record('other', 'a');
    counter.record('owner', 'b');

    expect(counter.record('owner', 'a')).toEqual({ alert: true, rejections: 2 });
  });

  it('starts over in a new window', () => {
    const c = clock();
    const counter = createRejectAlertCounter({ threshold: 2, windowMinutes: 10, now: c.now });
    counter.record('owner', 'a');
    counter.record('owner', 'a');

    c.advance(10 * 60_000);

    expect(counter.record('owner', 'a')).toEqual({ alert: false });
    expect(counter.record('owner', 'a')).toEqual({ alert: true, rejections: 2 });
  });

  it('a threshold of 0 never alerts', () => {
    const counter = createRejectAlertCounter({ threshold: 0, windowMinutes: 10, now: clock().now });

    for (let i = 0; i < 20; i += 1) expect(counter.record('owner', 'a')).toEqual({ alert: false });
  });
});
