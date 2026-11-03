// Wake-up throttle per (Cell, sender). Protects the agent from a sender that would
// otherwise wake it on every message. It is distinct from the storage quota of
// `domain/cells/send.ts`, which protects the mailbox: a refused event here is still a
// stored message, and it counts in the `unreadCount` of the next event.
//
// Windows are fixed, measured from the first admitted wake. State is in memory: losing
// it on restart costs nothing, because the replay after reconnecting covers the mailbox.

import type { UUIDv7 } from '#domain/auth/types.js';

export interface SenderThrottleConfig {
  wakeupsPerWindow: number;
  windowMs: number;
  /** Fires once per refused (Cell, sender) when its window ends. */
  onDeferredWake: (wake: DeferredWake) => void;
}

export interface DeferredWake {
  cellId: UUIDv7;
  senderId: UUIDv7;
  scheduledAt: Date;
}

export interface AdmitResult {
  admitted: boolean;
  deferredWakeAt: Date | null;
}

export interface SenderThrottle {
  admit(cellId: UUIDv7, senderId: UUIDv7, now: Date): AdmitResult;
  /** Forgets the counters of a closed Cell and cancels its deferred wakes. */
  dropCell(cellId: UUIDv7): void;
  /** Cancels every timer. The throttle is not usable afterwards. */
  stop(): void;
  /** Test helper — pairs currently tracked. */
  __entryCount(): number;
}

interface WindowEntry {
  cellId: UUIDv7;
  senderId: UUIDv7;
  windowStart: number;
  count: number;
  deferredTimer: NodeJS.Timeout | undefined;
}

export function createSenderThrottle(config: SenderThrottleConfig): SenderThrottle {
  const { wakeupsPerWindow, windowMs, onDeferredWake } = config;
  const entries = new Map<string, WindowEntry>();

  const keyOf = (cellId: UUIDv7, senderId: UUIDv7): string => `${cellId}:${senderId}`;

  function purgeExpired(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.deferredTimer === undefined && nowMs >= entry.windowStart + windowMs) {
        entries.delete(key);
      }
    }
  }

  const purgeTimer = setInterval(() => purgeExpired(Date.now()), windowMs);
  purgeTimer.unref();

  function scheduleDeferred(entry: WindowEntry, wakeAt: Date, nowMs: number): void {
    entry.deferredTimer = setTimeout(
      () => {
        entry.deferredTimer = undefined;
        // The deferred wake is the first wake of the next fixed window.
        entry.windowStart = wakeAt.getTime();
        entry.count = 1;
        onDeferredWake({ cellId: entry.cellId, senderId: entry.senderId, scheduledAt: wakeAt });
      },
      Math.max(0, wakeAt.getTime() - nowMs),
    );
    entry.deferredTimer.unref();
  }

  return {
    admit(cellId, senderId, now) {
      const nowMs = now.getTime();
      const key = keyOf(cellId, senderId);
      const entry = entries.get(key);

      if (
        entry === undefined ||
        (entry.deferredTimer === undefined && nowMs >= entry.windowStart + windowMs)
      ) {
        entries.set(key, {
          cellId,
          senderId,
          windowStart: nowMs,
          count: 1,
          deferredTimer: undefined,
        });
        return { admitted: true, deferredWakeAt: null };
      }

      if (entry.count < wakeupsPerWindow) {
        entry.count += 1;
        return { admitted: true, deferredWakeAt: null };
      }

      entry.count += 1;
      const wakeAt = new Date(entry.windowStart + windowMs);
      if (entry.deferredTimer === undefined) scheduleDeferred(entry, wakeAt, nowMs);
      return { admitted: false, deferredWakeAt: wakeAt };
    },

    dropCell(cellId) {
      for (const [key, entry] of entries) {
        if (entry.cellId !== cellId) continue;
        clearTimeout(entry.deferredTimer);
        entries.delete(key);
      }
    },

    stop() {
      clearInterval(purgeTimer);
      for (const entry of entries.values()) clearTimeout(entry.deferredTimer);
      entries.clear();
    },

    __entryCount() {
      return entries.size;
    },
  };
}
