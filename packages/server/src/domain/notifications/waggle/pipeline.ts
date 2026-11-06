// Waggle pipeline — orchestrates the online path. Subscribed by composition
// root to the Cell Store event emitter (`messageStored`, `cellClosed`).
// Per the tech spec § "waggle/pipeline.ts": handlers NEVER throw to the
// caller (Cell Store fires-and-forgets the event); failures funnel through
// the structured logger.

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import type { CellClosedEvent, CellsRepo, MessageStoredEvent } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';

import type { PresenceRegistry } from '#domain/notifications/presence/registry.js';

import type { Builder } from './builder.js';
import type { Consolidator } from './consolidator.js';
import type { DeferredWake, SenderThrottle } from './sender-throttle.js';
import type { WaggleNotification } from './types.js';

export interface PipelineDeps {
  presenceRegistry: PresenceRegistry;
  participantsRepo: ParticipantsReadRepo;
  cellsRepo: CellsRepo;
  builder: Builder;
  consolidator: Consolidator;
  senderThrottle: SenderThrottle;
  logger: Logger;
}

export interface Pipeline {
  /** Subscribed to `cellStore.events.on('messageStored', ...)`. Sync; never throws. */
  handleMessageStored(event: MessageStoredEvent): void;
  /** Subscribed to `cellStore.events.on('cellClosed', ...)`. Sync; never throws. */
  handleCellClosed(event: CellClosedEvent): void;
  /**
   * Invoked by the consolidator at window expiry. Resolves once the Waggle is built and
   * the fan-out launched, not when the deliveries end: a slow stream must not hold the
   * window of the Cell.
   */
  flushCell(cellId: UUIDv7, absorbedCount: number): Promise<void>;
  /** Invoked by the sender throttle when a deferred wake fires. Never throws. */
  handleDeferredWake(wake: DeferredWake): Promise<void>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  function logSuppressed(payload: {
    subCode: 'suspended' | 'retired' | 'revoked';
    messageId: UUIDv7;
    recipientId: UUIDv7;
    fromParticipantId: UUIDv7;
  }): void {
    deps.logger.info(
      {
        event: 'waggle_push_suppressed',
        ...payload,
      },
      'waggle push suppressed for non-active recipient',
    );
  }

  function logHandlerFailed(event: MessageStoredEvent, err: unknown): void {
    deps.logger.error(
      {
        event: 'waggle_handle_message_stored_failed',
        messageId: event.messageId,
        recipientId: event.recipientId,
        errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        errorMessage: err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
      },
      'waggle handler failed',
    );
  }

  function logDeliverFailed(
    handleConnectionId: UUIDv7,
    recipientId: UUIDv7,
    waggleKind: 'online' | 'replay',
    err: unknown,
  ): void {
    deps.logger.warn(
      {
        event: 'waggle_deliver_failed',
        subscriptionConnectionId: handleConnectionId,
        recipientId,
        waggleKind,
        errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        errorMessage: err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
      },
      'waggle deliver failed',
    );
  }

  async function fanOut(notification: WaggleNotification): Promise<void> {
    const { cellId, recipientId } = notification;
    let deliveredCount = 0;
    let attemptedCount = 0;
    await deps.presenceRegistry.forEachSubscriber(
      recipientId,
      async (handle) => {
        attemptedCount += 1;
        await handle.deliver(notification);
        deliveredCount += 1;
      },
      (handle, err) => {
        logDeliverFailed(handle.connectionId, recipientId, 'online', err);
      },
    );
    if (deliveredCount > 0) {
      deps.logger.info(
        {
          event: 'waggle_delivered',
          cellId,
          recipientId,
          waggleKind: 'online',
          deliveredCount,
          attemptedCount,
          coalescedCount: notification.coalescedCount,
        },
        'waggle delivered',
      );
    }
  }

  function logFlushFailed(cellId: UUIDv7, err: unknown): void {
    // Defense-in-depth — flushCell runs from a timer, so a thrown error would become an
    // unhandledRejection.
    deps.logger.error(
      {
        event: 'waggle_flush_failed',
        cellId,
        errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        errorMessage: err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
      },
      'waggle flushCell failed',
    );
  }

  const flushCell: Pipeline['flushCell'] = async (cellId, absorbedCount) => {
    try {
      const cell = await deps.cellsRepo.findCellById(cellId);
      if (!cell) return;
      if (cell.state !== 'active') return;

      const recipientId = cell.ownerId;

      const presence = deps.presenceRegistry.getPresence(recipientId);
      if (!presence.online) return;

      const participantState = await deps.participantsRepo.getParticipantState(recipientId);
      if (!participantState || participantState.state !== 'active') return;

      const notification = await deps.builder.buildOnlineWaggle({
        cellId,
        recipientId,
        coalescedCount: absorbedCount,
      });
      if (!notification) return;

      void fanOut(notification).catch((err: unknown) => {
        logFlushFailed(cellId, err);
      });
    } catch (err) {
      logFlushFailed(cellId, err);
    }
  };

  async function processMessageStored(event: MessageStoredEvent): Promise<void> {
    const recipientId = event.recipientId;
    const participantState = await deps.participantsRepo.getParticipantState(recipientId);
    if (!participantState) return;
    if (participantState.state !== 'active') {
      logSuppressed({
        subCode: participantState.state,
        messageId: event.messageId,
        recipientId,
        fromParticipantId: event.fromParticipantId,
      });
      return;
    }

    const throttle = deps.senderThrottle.admit(
      event.cellId,
      event.fromParticipantId,
      event.storedAt,
    );
    if (!throttle.admitted) {
      deps.logger.info(
        {
          event: 'waggle_wakeup_throttled',
          recipientId,
          cellId: event.cellId,
          fromParticipantId: event.fromParticipantId,
          deferredWakeAt: throttle.deferredWakeAt?.toISOString(),
        },
        'waggle wakeup throttled',
      );
      return;
    }

    deps.consolidator.absorb(event);
  }

  return {
    handleMessageStored(event) {
      // Sync on purpose: the event emitter does not wait, and the presence check must
      // run in the tick of the emit. Offline is a no-op: the replay covers it.
      try {
        if (!deps.presenceRegistry.getPresence(event.recipientId).online) return;
      } catch (err) {
        logHandlerFailed(event, err);
        return;
      }
      void processMessageStored(event).catch((err: unknown) => {
        logHandlerFailed(event, err);
      });
    },

    handleCellClosed(event) {
      try {
        deps.consolidator.cancelWindow(event.cellId);
        deps.senderThrottle.dropCell(event.cellId);
      } catch (err) {
        deps.logger.error(
          {
            event: 'waggle_handle_cell_closed_failed',
            cellId: event.cellId,
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            errorMessage:
              err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
          },
          'waggle cell-closed handler failed',
        );
      }
    },

    flushCell,

    async handleDeferredWake({ cellId, senderId, scheduledAt }) {
      try {
        const cell = await deps.cellsRepo.findCellById(cellId);
        if (!cell || cell.state !== 'active') return;
        const recipientId = cell.ownerId;
        if (!deps.presenceRegistry.getPresence(recipientId).online) return;
        const participantState = await deps.participantsRepo.getParticipantState(recipientId);
        if (!participantState || participantState.state !== 'active') return;
        deps.consolidator.absorb({
          kind: 'deferred_wake',
          cellId,
          recipientId,
          fromParticipantId: senderId,
          scheduledAt,
        });
      } catch (err) {
        logFlushFailed(cellId, err);
      }
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
