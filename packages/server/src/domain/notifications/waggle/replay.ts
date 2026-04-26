// Replay path — fired by `presenceRegistry.subscribe` for a fresh subscription.
// Per the tech spec § "waggle/replay.ts": queued via `setImmediate` (or a
// configurable delay) so the subscribe call returns immediately; the actual
// catch-up runs on the next tick.

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import type { CellsRepo } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';

import type { SubscriberHandle } from '../presence/subscriber-handle.js';

import type { Builder } from './builder.js';

export interface ReplayDeps {
  cellsRepo: CellsRepo;
  participantsRepo: ParticipantsReadRepo;
  builder: Builder;
  logger: Logger;
}

export interface ReplayConfig {
  /** Delay before scheduling `runReplayFor`. 0 (default) → next tick via setImmediate. */
  replayDelayMs: number;
}

export interface Replay {
  /** Non-blocking — schedules the actual replay on the next tick. */
  scheduleReplayFor(participantId: UUIDv7, handle: SubscriberHandle, subscriptionId: UUIDv7): void;
  /** Public for testing — the synchronous path. */
  runReplayFor(
    participantId: UUIDv7,
    handle: SubscriberHandle,
    subscriptionId: UUIDv7,
  ): Promise<void>;
}

export function createReplay(deps: ReplayDeps, config: ReplayConfig): Replay {
  const runReplayFor: Replay['runReplayFor'] = async (participantId, handle, subscriptionId) => {
    try {
      // Re-resolve the Cell — the participant may have been revoked between
      // subscribe and this tick (cells cascade-close on revoke).
      const cell = await deps.cellsRepo.findCellByOwner(participantId);
      if (!cell) return;
      if (cell.state !== 'active') return;

      // Re-verify the participant state. If the verifier accepted at subscribe
      // time but the participant was suspended seconds later, do not push.
      const participantState = await deps.participantsRepo.getParticipantState(participantId);
      if (!participantState || participantState.state !== 'active') return;

      const notification = await deps.builder.buildReplayWaggle({
        cellId: cell.id,
        recipientId: participantId,
      });
      // Empty Cell on replay: do not emit (per product edge case).
      if (!notification) return;

      // Per-subscription delivery — NOT fan-out. Replay belongs to the new
      // session only; sister sessions already received their own replay or
      // are receiving online events.
      try {
        await handle.deliver(notification);
      } catch (err) {
        deps.logger.warn(
          {
            event: 'waggle_deliver_failed',
            subscriptionConnectionId: handle.connectionId,
            recipientId: participantId,
            waggleKind: 'replay',
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            errorMessage:
              err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
          },
          'waggle replay deliver failed',
        );
      }
    } catch (err) {
      deps.logger.error(
        {
          event: 'waggle_replay_failed',
          participantId,
          subscriptionId,
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          errorMessage:
            err instanceof Error ? truncate(err.message, 512) : String(err).slice(0, 512),
        },
        'waggle replay failed',
      );
      // Never re-throw — the session stays alive; the client can poll
      // `check_unread_messages` instead.
    }
  };

  function schedule(participantId: UUIDv7, handle: SubscriberHandle, subscriptionId: UUIDv7): void {
    const run = (): void => {
      void runReplayFor(participantId, handle, subscriptionId);
    };
    if (config.replayDelayMs > 0) {
      setTimeout(run, config.replayDelayMs);
      return;
    }
    setImmediate(run);
  }

  return {
    scheduleReplayFor: schedule,
    runReplayFor,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
