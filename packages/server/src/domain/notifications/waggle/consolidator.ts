// Quiet-window consolidator — one window per Cell at a time.
//
// Anti lost-wakeup invariant: no absorb may end up without a future window covering it.
// `generation` grows on every absorb. When a flush ends, a grown generation re-arms the
// window instead of deleting it, so an event absorbed after the flush read the mailbox
// still wakes the agent. The extra Waggle may repeat an observable state (same eventId):
// at-least-once, and a client can drop it by eventId.

import type { UUIDv7 } from '#domain/auth/types.js';

import type { MessageStoredEvent } from '#domain/cells/index.js';

import type { DeferredWakeEvent } from './types.js';

interface WindowEntry {
  cellId: UUIDv7;
  openedAt: Date;
  /** Admitted events absorbed; deferred wakes do not count. */
  absorbedCount: number;
  /** +1 on every absorb, deferred wakes included. */
  generation: number;
  timer: NodeJS.Timeout;
}

export interface ConsolidatorConfig {
  /** Quiet window duration. Default 500ms (test envs use 10ms). */
  quietWindowMs: number;
}

/** Callback the consolidator invokes when the window expires. */
export type FlushCallback = (cellId: UUIDv7, absorbedCount: number) => Promise<void>;

export interface Consolidator {
  /** Registers the event in the open window of its Cell, or opens one. */
  absorb(event: MessageStoredEvent | DeferredWakeEvent): void;
  /** Synchronous cancellation — `clearTimeout` + map delete. No flush occurs after cancel. */
  cancelWindow(cellId: UUIDv7): void;
  /** Test helper — current number of open windows. */
  __activeWindowCount(): number;
}

function isDeferredWake(event: MessageStoredEvent | DeferredWakeEvent): event is DeferredWakeEvent {
  return (event as DeferredWakeEvent).kind === 'deferred_wake';
}

export function createConsolidator(config: ConsolidatorConfig, flush: FlushCallback): Consolidator {
  const windows = new Map<UUIDv7, WindowEntry>();

  function arm(cellId: UUIDv7): NodeJS.Timeout {
    return setTimeout(() => {
      void onWindowElapsed(cellId);
    }, config.quietWindowMs);
  }

  async function onWindowElapsed(cellId: UUIDv7): Promise<void> {
    const entry = windows.get(cellId);
    if (entry === undefined) return;
    const snapshot = { generation: entry.generation, absorbed: entry.absorbedCount };
    try {
      await flush(cellId, snapshot.absorbed);
    } catch {
      // Swallow — the flush callback owns its logging; this is a timer path, and a
      // rejection here would become an unhandledRejection.
    } finally {
      // Identity, not only generation: a window cancelled and reopened during the flush
      // owns its own timer and must be left alone.
      if (windows.get(cellId) === entry) {
        if (entry.generation > snapshot.generation) {
          entry.absorbedCount -= snapshot.absorbed;
          entry.generation = 1;
          entry.openedAt = new Date();
          entry.timer = arm(cellId);
        } else {
          windows.delete(cellId);
        }
      }
    }
  }

  return {
    absorb(event) {
      const admitted = isDeferredWake(event) ? 0 : 1;
      const entry = windows.get(event.cellId);
      if (entry !== undefined) {
        entry.generation += 1;
        entry.absorbedCount += admitted;
        return;
      }
      windows.set(event.cellId, {
        cellId: event.cellId,
        openedAt: new Date(),
        absorbedCount: admitted,
        generation: 1,
        timer: arm(event.cellId),
      });
    },

    cancelWindow(cellId) {
      const entry = windows.get(cellId);
      if (!entry) return;
      clearTimeout(entry.timer);
      windows.delete(cellId);
    },

    __activeWindowCount() {
      return windows.size;
    },
  };
}
