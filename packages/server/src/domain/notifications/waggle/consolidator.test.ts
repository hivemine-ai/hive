// Unit tests for the consolidator. Uses vitest fake timers to drive the
// quiet window deterministically.

import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageDeliveredEvent } from '#domain/cells/index.js';

import { createConsolidator, type FlushCallback } from './consolidator.js';

function event(cellId = uuidv7()): MessageDeliveredEvent {
  return {
    messageId: uuidv7(),
    cellId,
    recipientId: uuidv7(),
    fromParticipantId: uuidv7(),
    type: 'notification',
    deliveredAt: new Date(),
  };
}

describe('createConsolidator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('absorb opens a window; flush fires after quietWindowMs with the right cellId', async () => {
    const flushed: string[] = [];
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 100 }, flush);
    const ev = event();

    consolidator.absorb(ev);
    expect(consolidator.__activeWindowCount()).toBe(1);
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);

    expect(flushed).toEqual([ev.cellId]);
    expect(consolidator.__activeWindowCount()).toBe(0);
  });

  it('two absorbs in the same window → single flush', async () => {
    const flushed: string[] = [];
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    consolidator.absorb(event(cellId));
    expect(consolidator.__activeWindowCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(50);

    expect(flushed).toEqual([cellId]);
  });

  it('cancelWindow before flush prevents the flush from firing', async () => {
    const flushed: string[] = [];
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 100 }, flush);
    const ev = event();

    consolidator.absorb(ev);
    consolidator.cancelWindow(ev.cellId);
    expect(consolidator.__activeWindowCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(200);

    expect(flushed).toHaveLength(0);
  });

  it('cancelWindow on unknown cellId is a no-op', () => {
    const consolidator = createConsolidator({ quietWindowMs: 100 }, () => Promise.resolve());
    expect(() => consolidator.cancelWindow(uuidv7())).not.toThrow();
  });

  it('absorb after a previous window closed opens a fresh window', async () => {
    const flushed: string[] = [];
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    expect(flushed).toEqual([cellId]);

    consolidator.absorb(event(cellId));
    expect(consolidator.__activeWindowCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(flushed).toEqual([cellId, cellId]);
  });

  it('events for two distinct Cells open independent windows; both flush in their own time', async () => {
    const flushed: string[] = [];
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 100 }, flush);
    const cellA = uuidv7();
    const cellB = uuidv7();

    consolidator.absorb(event(cellA));
    consolidator.absorb(event(cellB));
    expect(consolidator.__activeWindowCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(100);

    expect(flushed).toContain(cellA);
    expect(flushed).toContain(cellB);
    expect(flushed).toHaveLength(2);
  });

  it('event arriving WHILE the flush is in flight is absorbed (not double-flushed)', async () => {
    const flushed: string[] = [];
    let flushResolve: (() => void) | undefined;
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      // Hold the flush open so we can simulate an in-flight event.
      return new Promise<void>((resolve) => {
        flushResolve = resolve;
      });
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    // Flush started, not finished. Window should still be alive (delete is in finally).
    expect(consolidator.__activeWindowCount()).toBe(1);

    // Event arriving now should be absorbed silently — no second window.
    consolidator.absorb(event(cellId));
    expect(consolidator.__activeWindowCount()).toBe(1);

    // Release the flush; window closes.
    flushResolve?.();
    await vi.runAllTimersAsync();

    // Drain microtasks so the `finally` runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(flushed).toHaveLength(1);
    expect(consolidator.__activeWindowCount()).toBe(0);
  });

  it('flush callback that throws does not crash the consolidator (window still cleared)', async () => {
    const flush: FlushCallback = () => Promise.reject(new Error('flush boom'));
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    // Drain microtasks so the `finally` runs even after a rejected flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(consolidator.__activeWindowCount()).toBe(0);
  });
});
