// Internal in-process event emitter for the Cell Store domain.
//
// Per the tech spec ("cells/events.ts" section): mono-process per ADR-003. Subscribers
// such as Waggle, audit log, and metrics attach via `on()` without coupling to the
// concrete implementation; the typed facade enforces payload shape per event name.
//
// The emit-after-commit guarantee (sendMessage → events.emit) is the responsibility
// of the caller (`cells/send.ts`), not the emitter itself. The emitter is "best
// effort": a throwing listener is logged by the caller, never rolled back into the
// originating transaction (per tech spec line 408-409).
//
// Implementation: thin typed wrapper around Node's built-in `EventEmitter`. Keeps
// the surface intentionally small (`emit`, `on`, `off`) so subscribers don't lean
// on Node-specific affordances (`once`, `prependListener`, etc.) that would couple
// them to the concrete emitter.

import { EventEmitter } from 'node:events';

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

export type CellEventListener<E extends CellEventName> = (payload: CellEventMap[E]) => void;

export interface CellEvents {
  emit<E extends CellEventName>(event: E, payload: CellEventMap[E]): void;
  on<E extends CellEventName>(event: E, listener: CellEventListener<E>): void;
  off<E extends CellEventName>(event: E, listener: CellEventListener<E>): void;
}

export function createCellEvents(): CellEvents {
  const emitter = new EventEmitter();
  // Increase the default cap (10) — multiple subscribers (Waggle, metrics, audit)
  // are expected in steady state and we don't want spurious "MaxListenersExceeded"
  // warnings. 0 = unlimited.
  emitter.setMaxListeners(0);

  return {
    emit(event, payload) {
      emitter.emit(event, payload);
    },
    on(event, listener) {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
  };
}
