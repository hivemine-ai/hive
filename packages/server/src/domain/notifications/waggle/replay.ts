// Replay path — fired from `Subscription.ready()` via the `onReady` hook, so always after
// the acknowledgment, and on resume for streams that survived a suspension. Queued via
// `setImmediate` (or a configurable delay). `hivectl watch` queries nothing on connect
// and depends on this event, so a failure must not stay silent: it closes the stream,
// the client reconnects, and the replay repeats after the new acknowledgment.

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import type { CellsRepo } from '#domain/cells/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';

import type { PresenceRegistry } from '#domain/notifications/presence/registry.js';
import type { SubscriberHandle } from '#domain/notifications/presence/subscriber-handle.js';

import type { Builder } from './builder.js';

export interface ReplayDeps {
  cellsRepo: CellsRepo;
  participantsRepo: ParticipantsReadRepo;
  builder: Builder;
  presenceRegistry: Pick<PresenceRegistry, 'isOpen' | 'unsubscribe'>;
  logger: Logger;
}

export interface ReplayConfig {
  /** Delay before scheduling `runReplayFor`. 0 (default) → next tick via setImmediate. */
  replayDelayMs: number;
}

export interface Replay {
  /** Non-blocking — schedules the actual replay on the next tick. */
  scheduleReplayFor(participantId: UUIDv7, handle: SubscriberHandle, subscriptionId: UUIDv7): void;
  /** Public for testing — the synchronous path. Throws on failure; `scheduleReplayFor` closes the stream. */
  runReplayFor(
    participantId: UUIDv7,
    handle: SubscriberHandle,
    subscriptionId: UUIDv7,
  ): Promise<void>;
}

export function createReplay(deps: ReplayDeps, config: ReplayConfig): Replay {
  const runReplayFor: Replay['runReplayFor'] = async (participantId, handle, subscriptionId) => {
    // Re-resolve the Cell — the participant may have been revoked since ready()
    // (cells cascade-close on revoke).
    const cell = await deps.cellsRepo.findCellByOwner(participantId);
    if (!cell || cell.state !== 'active') return;

    const participantState = await deps.participantsRepo.getParticipantState(participantId);
    if (!participantState || participantState.state !== 'active') return;

    if (!deps.presenceRegistry.isOpen(subscriptionId, participantId)) return;

    const notification = await deps.builder.buildReplayWaggle({
      cellId: cell.id,
      recipientId: participantId,
    });
    // Empty Cell on replay: do not emit (per product edge case).
    if (!notification) return;

    // Per-subscription delivery — NOT fan-out. Sister streams already had their own
    // replay or are receiving online events.
    await handle.deliver(notification);
  };

  async function runAndCloseOnFailure(
    participantId: UUIDv7,
    handle: SubscriberHandle,
    subscriptionId: UUIDv7,
  ): Promise<void> {
    try {
      await runReplayFor(participantId, handle, subscriptionId);
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
      deps.presenceRegistry.unsubscribe(subscriptionId, participantId, 'replay_failed');
      handle.close('replay_failed');
    }
  }

  function schedule(participantId: UUIDv7, handle: SubscriberHandle, subscriptionId: UUIDv7): void {
    const run = (): void => {
      void runAndCloseOnFailure(participantId, handle, subscriptionId);
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
