// Waggle pipeline — orchestrates the online path. Subscribed by composition
// root to the Cell Store event emitter (`messageDelivered`, `cellClosed`).
// Per the tech spec § "waggle/pipeline.ts": handlers NEVER throw to the
// caller (Cell Store fires-and-forgets the event); failures funnel through
// the structured logger.

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import type { CellClosedEvent, CellsRepo, MessageDeliveredEvent } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';

import type { PresenceRegistry } from '../presence/registry.js';

import type { Builder } from './builder.js';
import type { Consolidator } from './consolidator.js';

export interface PipelineDeps {
  presenceRegistry: PresenceRegistry;
  participantsRepo: ParticipantsReadRepo;
  cellsRepo: CellsRepo;
  builder: Builder;
  consolidator: Consolidator;
  logger: Logger;
}

export interface Pipeline {
  /** Subscribed to `cellStore.events.on('messageDelivered', ...)`. Sync; never throws. */
  handleMessageDelivered(event: MessageDeliveredEvent): void;
  /** Subscribed to `cellStore.events.on('cellClosed', ...)`. Sync; never throws. */
  handleCellClosed(event: CellClosedEvent): void;
  /** Invoked by the consolidator at window expiry. */
  flushCell(cellId: UUIDv7): Promise<void>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  function logSuppressed(payload: {
    subCode: 'suspended' | 'revoked';
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

  function logHandlerFailed(event: MessageDeliveredEvent, err: unknown): void {
    deps.logger.error(
      {
        event: 'waggle_handle_message_delivered_failed',
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

  const flushCell: Pipeline['flushCell'] = async (cellId) => {
    try {
      const cell = await deps.cellsRepo.findCellById(cellId);
      if (!cell) return;
      if (cell.state !== 'active') return;

      const recipientId = cell.ownerId;

      const presence = deps.presenceRegistry.getPresence(recipientId);
      if (!presence.online) return;

      const participantState = await deps.participantsRepo.getParticipantState(recipientId);
      if (!participantState || participantState.state !== 'active') return;

      const notification = await deps.builder.buildOnlineWaggle({ cellId, recipientId });
      if (!notification) return;

      await deps.presenceRegistry.forEachSubscriber(
        recipientId,
        async (handle) => {
          await handle.deliver(notification);
        },
        (handle, err) => {
          logDeliverFailed(handle.connectionId, recipientId, 'online', err);
        },
      );
    } catch (err) {
      // Defense-in-depth — flushCell is invoked from a setTimeout callback, so
      // a thrown error would become an unhandledRejection.
      deps.logger.error(
        {
          event: 'waggle_flush_failed',
          cellId,
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          errorMessage:
            err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
        },
        'waggle flushCell failed',
      );
    }
  };

  return {
    handleMessageDelivered(event) {
      // The handler MUST be sync to match the EventEmitter sync contract
      // documented in the spec. The async work is fired-and-forgotten — any
      // failure is captured by the inner try/catch and logged.
      void (async () => {
        try {
          const recipientId = event.recipientId;
          const presence = deps.presenceRegistry.getPresence(recipientId);
          if (!presence.online) {
            // Offline: replay will cover. No-op.
            return;
          }
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
          deps.consolidator.absorb(event);
        } catch (err) {
          logHandlerFailed(event, err);
        }
      })();
    },

    handleCellClosed(event) {
      try {
        deps.consolidator.cancelWindow(event.cellId);
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
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
