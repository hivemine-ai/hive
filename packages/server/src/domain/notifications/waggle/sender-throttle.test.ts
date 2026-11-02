import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSenderThrottle, type DeferredWake } from './sender-throttle.js';

const WINDOW_MS = 1000;

describe('createSenderThrottle', () => {
  const cell = uuidv7();
  const sender = uuidv7();
  let wakes: DeferredWake[];

  const build = (wakeupsPerWindow = 2) =>
    createSenderThrottle({
      wakeupsPerWindow,
      windowMs: WINDOW_MS,
      onDeferredWake: (wake) => wakes.push(wake),
    });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00.000Z') });
    wakes = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits up to the limit inside the fixed window, then refuses with the wake time', () => {
    const throttle = build();
    const at = new Date();
    expect(throttle.admit(cell, sender, at)).toEqual({ admitted: true, deferredWakeAt: null });
    expect(throttle.admit(cell, sender, at)).toEqual({ admitted: true, deferredWakeAt: null });
    expect(throttle.admit(cell, sender, at)).toEqual({
      admitted: false,
      deferredWakeAt: new Date(at.getTime() + WINDOW_MS),
    });
    throttle.stop();
  });

  it('the window is measured from the first admitted wake, it does not slide', async () => {
    const throttle = build(1);
    throttle.admit(cell, sender, new Date());
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(throttle.admit(cell, sender, new Date()).admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The deferred wake opened the next window and counts as its first wake.
    expect(wakes).toHaveLength(1);
    expect(throttle.admit(cell, sender, new Date()).admitted).toBe(false);
    throttle.stop();
  });

  it('an event past an expired window with nothing deferred opens a new one', async () => {
    const throttle = build(1);
    throttle.admit(cell, sender, new Date());
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(throttle.admit(cell, sender, new Date()).admitted).toBe(true);
    expect(wakes).toHaveLength(0);
    throttle.stop();
  });

  it('schedules one deferred wake per pair, however many refusals', async () => {
    const throttle = build(1);
    for (let i = 0; i < 20; i += 1) throttle.admit(cell, sender, new Date());
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ cellId: cell, senderId: sender });
    throttle.stop();
  });

  it('a noisy sender does not consume the quota of another sender', () => {
    const throttle = build(1);
    const other = uuidv7();
    throttle.admit(cell, sender, new Date());
    expect(throttle.admit(cell, sender, new Date()).admitted).toBe(false);
    expect(throttle.admit(cell, other, new Date()).admitted).toBe(true);
    throttle.stop();
  });

  it('dropCell cancels pending wakes and counters', async () => {
    const throttle = build(1);
    throttle.admit(cell, sender, new Date());
    throttle.admit(cell, sender, new Date());
    throttle.dropCell(cell);
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(wakes).toHaveLength(0);
    expect(throttle.admit(cell, sender, new Date()).admitted).toBe(true);
    throttle.stop();
  });

  it('purges expired pairs and stop() cancels everything', async () => {
    const throttle = build(1);
    throttle.admit(cell, sender, new Date());
    expect(throttle.__entryCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(throttle.__entryCount()).toBe(0);

    throttle.admit(cell, sender, new Date());
    throttle.admit(cell, sender, new Date());
    throttle.stop();
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(wakes).toHaveLength(0);
  });
});
