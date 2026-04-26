// Quiet-window consolidator — one window per Cell at a time. Per the tech spec
// § "waggle/consolidator.ts" + "Casos límite técnicos: window-vencida-pre-flush":
// the `windows.delete(cellId)` runs in the timer callback's `finally` AFTER
// the flush completes, so events arriving during the flush see the window
// still alive and absorb (no double-flush).

import type { UUIDv7 } from '#domain/auth/types.js';

import type { MessageDeliveredEvent } from '#domain/cells/index.js';

interface WindowEntry {
  cellId: UUIDv7;
  openedAt: Date;
  timer: NodeJS.Timeout;
}

export interface ConsolidatorConfig {
  /** Quiet window duration. Default 500ms (test envs use 10ms). */
  quietWindowMs: number;
}

/** Callback the consolidator invokes when the window expires. */
export type FlushCallback = (cellId: UUIDv7) => Promise<void>;

export interface Consolidator {
  /** Idempotent within a window — extra absorbs while a window is open are
   *  silently discarded; the eventual flush queries the live Cell state. */
  absorb(event: MessageDeliveredEvent): void;
  /** Synchronous cancellation — `clearTimeout` + map delete. Used by
   *  `handleCellClosed`. No flush occurs after cancel. */
  cancelWindow(cellId: UUIDv7): void;
  /** Test helper — current number of open windows. */
  __activeWindowCount(): number;
}

export function createConsolidator(config: ConsolidatorConfig, flush: FlushCallback): Consolidator {
  const windows = new Map<UUIDv7, WindowEntry>();

  return {
    absorb(event) {
      if (windows.has(event.cellId)) {
        // Window already open. The eventual flush re-queries `summarizeUnreadForCell`
        // so the new message is captured in the consolidated payload.
        return;
      }
      const cellId = event.cellId;
      const timer = setTimeout(() => {
        // Run the flush inside an async IIFE so the timer callback itself stays
        // sync. The flush callback is best-effort: any rejection is caught here
        // so it cannot escape as `unhandledRejection`. The pipeline's own
        // `flushCell` already logs failures internally; this catch is the
        // last-line defense for callers that pass a thrower (mostly tests).
        void (async () => {
          try {
            await flush(cellId);
          } catch {
            // Swallow — caller is responsible for logging via its own scope.
          } finally {
            // Delete LAST so events arriving while flush is in flight see the
            // window still open (and absorb), avoiding double-flush.
            windows.delete(cellId);
          }
        })();
      }, config.quietWindowMs);
      windows.set(cellId, { cellId, openedAt: new Date(), timer });
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
