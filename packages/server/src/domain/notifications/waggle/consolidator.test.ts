// Unit tests for the consolidator. Uses vitest fake timers to drive the
// quiet window deterministically.

import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageStoredEvent } from '#domain/cells/index.js';

import { createConsolidator, type FlushCallback } from './consolidator.js';
import type { DeferredWakeEvent } from './types.js';

function event(cellId = uuidv7()): MessageStoredEvent {
  return {
    messageId: uuidv7(),
    cellId,
    recipientId: uuidv7(),
    fromParticipantId: uuidv7(),
    type: 'notification',
    storedAt: new Date(),
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

  it('an absorb during an in-flight flush re-arms a window (no lost wakeup)', async () => {
    const flushed: string[] = [];
    let flushResolve: (() => void) | undefined;
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return new Promise<void>((resolve) => {
        flushResolve = resolve;
      });
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    expect(consolidator.__activeWindowCount()).toBe(1);

    // Arrives after the flush took its snapshot and before it resolved.
    consolidator.absorb(event(cellId));
    flushResolve?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(consolidator.__activeWindowCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    flushResolve?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(flushed).toHaveLength(2);
    expect(consolidator.__activeWindowCount()).toBe(0);
  });

  it('reports the admitted events of each flush; re-arming carries only the pending ones', async () => {
    const counts: number[] = [];
    let release: (() => void) | undefined;
    const flush: FlushCallback = (_cellId, absorbedCount) => {
      counts.push(absorbedCount);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    consolidator.absorb(event(cellId));
    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    consolidator.absorb(event(cellId));
    release?.();
    await vi.advanceTimersByTimeAsync(50);
    release?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(counts).toEqual([3, 1]);
  });

  it('a deferred wake opens or extends a window without counting as admitted', async () => {
    const counts: number[] = [];
    let release: (() => void) | undefined;
    const flush: FlushCallback = (_cellId, absorbedCount) => {
      counts.push(absorbedCount);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();
    const wake: DeferredWakeEvent = {
      kind: 'deferred_wake',
      cellId,
      recipientId: uuidv7(),
      fromParticipantId: uuidv7(),
      scheduledAt: new Date(),
    };

    consolidator.absorb(wake);
    await vi.advanceTimersByTimeAsync(50);
    // Late deferred wake during the flush: must not be lost either.
    consolidator.absorb(wake);
    release?.();
    await vi.advanceTimersByTimeAsync(50);
    release?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(counts).toEqual([0, 0]);
  });

  it('a hung flush never blocks another Cell', async () => {
    const flushed: string[] = [];
    const hung = uuidv7();
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return cellId === hung ? new Promise<void>(() => undefined) : Promise.resolve();
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const other = uuidv7();

    consolidator.absorb(event(hung));
    await vi.advanceTimersByTimeAsync(50);
    consolidator.absorb(event(other));
    await vi.advanceTimersByTimeAsync(50);

    expect(flushed).toEqual([hung, other]);
  });

  it('a window cancelled during the flush and re-opened keeps its own timer', async () => {
    const flushed: string[] = [];
    let release: (() => void) | undefined;
    const flush: FlushCallback = (cellId) => {
      flushed.push(cellId);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const consolidator = createConsolidator({ quietWindowMs: 50 }, flush);
    const cellId = uuidv7();

    consolidator.absorb(event(cellId));
    await vi.advanceTimersByTimeAsync(50);
    consolidator.cancelWindow(cellId);
    consolidator.absorb(event(cellId));
    release?.();
    await vi.advanceTimersByTimeAsync(0);

    // The finally of the first flush must not delete the new window.
    expect(consolidator.__activeWindowCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(flushed).toHaveLength(2);
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
