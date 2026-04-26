// Internal in-process event emitter for the Cell Store domain.
//
// Per the tech spec ("cells/events.ts" section): mono-process per ADR-003.
// Subscribers (Waggle, audit log, metrics) attach via `on()` without coupling to
// the concrete implementation; the typed facade enforces payload shape per event.
//
// The emit-after-commit guarantee (sendMessage → events.emit) is the caller's
// responsibility (`cells/send.ts`), not the emitter's. The emitter is "best
// effort" per tech spec line 408-409: errors raised by listeners NEVER bubble
// up to the caller and never participate in the caller's transaction.
//
// PRY-010 hardening: emit iterates listeners explicitly, wrapping each invocation
// in try/catch (sync throws) AND attaching a `.catch(...)` to any returned
// Promise (async rejections). Both error paths funnel into the `onError`
// callback the caller may supply per emit. The previous Node EventEmitter-based
// path silently turned async rejections into `unhandledRejection`.

import type { UUIDv7 } from '#domain/auth/types.js';

import type { MessageType } from './types.js';

export interface MessageDeliveredEvent {
  messageId: UUIDv7;
  cellId: UUIDv7;
  recipientId: UUIDv7;
  fromParticipantId: UUIDv7;
  type: MessageType;
  deliveredAt: Date;
}

export interface CellClosedEvent {
  cellId: UUIDv7;
  ownerId: UUIDv7;
  closedAt: Date;
  reason: 'participant_revoked' | 'hivekeeper_cascade';
}

export interface CellEventMap {
  messageDelivered: MessageDeliveredEvent;
  cellClosed: CellClosedEvent;
}

export type CellEventName = keyof CellEventMap;

// Listener return type is intentionally `unknown` — listeners may return void,
// a Promise, or any other value (which the emitter ignores). Returning a Promise
// lets us catch async rejections; returning a value-typed expression (e.g.
// `events.push(payload)` returning `number`) keeps the surface ergonomic.
export type CellEventListener<E extends CellEventName> = (payload: CellEventMap[E]) => unknown;

export type EmitErrorSink = (err: unknown) => void;

export interface CellEvents {
  /**
   * Fire `event` to all subscribed listeners. Per-listener exceptions (sync
   * throws OR returned-Promise rejections) are caught and forwarded to
   * `onError` if provided, then swallowed. Never throws to the caller.
   */
  emit<E extends CellEventName>(event: E, payload: CellEventMap[E], onError?: EmitErrorSink): void;
  on<E extends CellEventName>(event: E, listener: CellEventListener<E>): void;
  off<E extends CellEventName>(event: E, listener: CellEventListener<E>): void;
}

type AnyListener = (payload: unknown) => unknown;

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function'
  );
}

function safeReportError(sink: EmitErrorSink | undefined, err: unknown): void {
  if (!sink) return;
  try {
    sink(err);
  } catch {
    // Swallow — if the error sink itself throws, we have nothing sensible to
    // do; never let this leak to unhandledRejection.
  }
}

export function createCellEvents(): CellEvents {
  const sets = new Map<CellEventName, Set<AnyListener>>();

  function getOrCreate(event: CellEventName): Set<AnyListener> {
    let set = sets.get(event);
    if (!set) {
      set = new Set();
      sets.set(event, set);
    }
    return set;
  }

  return {
    emit(event, payload, onError) {
      const set = sets.get(event);
      if (!set || set.size === 0) return;
      // Snapshot first so a listener that mutates the set during emit does not
      // affect this fan-out (matches Node's EventEmitter contract).
      const snapshot = Array.from(set);
      for (const listener of snapshot) {
        // Each listener gets its own try/catch — an error in one MUST NOT
        // prevent the rest from firing.
        try {
          const result = listener(payload);
          if (isPromiseLike(result)) {
            result.catch((err) => safeReportError(onError, err));
          }
        } catch (err) {
          safeReportError(onError, err);
        }
      }
    },
    on(event, listener) {
      getOrCreate(event).add(listener as AnyListener);
    },
    off(event, listener) {
      sets.get(event)?.delete(listener as AnyListener);
    },
  };
}
