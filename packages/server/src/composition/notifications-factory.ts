// Composition root for the Waggle pipeline + Presence Registry — wires the
// real implementation from its dependencies. The wiring is synchronous and
// MUST complete BEFORE the MCP server accepts its first connection (per the
// tech spec: the first `messageStored` is only possible after a
// `sendMessage` from an authenticated client, which requires an accepted MCP
// session, which requires this wiring already in place).
//
// CRITICAL: the event emitter of cellStore MUST preserve sync semantics —
// the race analysis in the Waggle Pipeline + Presence Registry tech spec
// assumes `cellStore.events.emit('messageStored', event)` invokes all
// listeners synchronously in the same tick before `emit` returns. The
// in-tree `createCellEvents` (Cell Store) already satisfies this; if it is
// ever swapped for an async-emit lib the race analysis must be revisited.

import type { ParticipantStateChange, ParticipantsReadRepo } from '#domain/auth/index.js';
import type { CellEvents, CellsRepo } from '#domain/cells/index.js';
import {
  createBuilder,
  createConsolidator,
  createPipeline,
  createPresenceRegistry,
  createReplay,
  createSenderThrottle,
} from '#domain/notifications/index.js';
import type {
  Builder,
  Consolidator,
  Pipeline,
  PresenceRegistry,
  Replay,
  SenderThrottle,
} from '#domain/notifications/index.js';
import { parseIntEnv } from '#observability/env.js';
import type { Logger } from '#observability/logger.js';

export interface NotificationsFactoryDeps {
  cellEvents: CellEvents;
  cellsRepo: CellsRepo;
  participantsRepo: ParticipantsReadRepo;
  logger: Logger;
}

export interface NotificationsFactoryOptions {
  /** Default 500ms. Tests / latency-sensitive deployments can override. */
  quietWindowMs?: number;
  /** Default 0 (next tick via setImmediate). */
  replayDelayMs?: number;
  /** Default 16. */
  maxSessionsPerParticipant?: number;
  /** Default 5 (provisional). */
  senderWakeupsPerWindow?: number;
  /** Default 60000ms (provisional). */
  senderWindowMs?: number;
  /** Default 10000ms (provisional). */
  claimReservationMs?: number;
}

export interface Notifications {
  presenceRegistry: PresenceRegistry;
  pipeline: Pipeline;
  builder: Builder;
  consolidator: Consolidator;
  senderThrottle: SenderThrottle;
  replay: Replay;
  /** Wired to the state signal of Auth. Best-effort and idempotent. */
  handleParticipantStateChanged(change: ParticipantStateChange): void;
  /** Cancels the timers of the subsystem. */
  stop(): void;
}

const DEFAULT_QUIET_WINDOW_MS = 500;
const DEFAULT_REPLAY_DELAY_MS = 0;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_SENDER_WAKEUPS_PER_WINDOW = 5;
const DEFAULT_SENDER_WINDOW_MS = 60_000;
const DEFAULT_CLAIM_RESERVATION_MS = 10_000;

export function resolveNotificationsConfig(
  env: NodeJS.ProcessEnv,
  options: NotificationsFactoryOptions = {},
): {
  quietWindowMs: number;
  replayDelayMs: number;
  maxSessionsPerParticipant: number;
  senderWakeupsPerWindow: number;
  senderWindowMs: number;
  claimReservationMs: number;
} {
  const quietWindowMs =
    options.quietWindowMs ??
    parseIntEnv(env['HIVE_WAGGLE_QUIET_WINDOW_MS'], DEFAULT_QUIET_WINDOW_MS, {
      name: 'HIVE_WAGGLE_QUIET_WINDOW_MS',
      min: 1,
    });
  const replayDelayMs =
    options.replayDelayMs ??
    parseIntEnv(env['HIVE_WAGGLE_REPLAY_DELAY_MS'], DEFAULT_REPLAY_DELAY_MS, {
      name: 'HIVE_WAGGLE_REPLAY_DELAY_MS',
      min: 0,
    });
  const maxSessionsPerParticipant =
    options.maxSessionsPerParticipant ??
    parseIntEnv(env['HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT'], DEFAULT_MAX_SESSIONS, {
      name: 'HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT',
      min: 1,
    });

  const senderWakeupsPerWindow =
    options.senderWakeupsPerWindow ??
    parseIntEnv(env['HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW'], DEFAULT_SENDER_WAKEUPS_PER_WINDOW, {
      name: 'HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW',
      min: 1,
    });
  const senderWindowMs =
    options.senderWindowMs ??
    parseIntEnv(env['HIVE_WAGGLE_SENDER_WINDOW_MS'], DEFAULT_SENDER_WINDOW_MS, {
      name: 'HIVE_WAGGLE_SENDER_WINDOW_MS',
      min: 1,
    });
  const claimReservationMs =
    options.claimReservationMs ??
    parseIntEnv(env['HIVE_PRESENCE_CLAIM_RESERVATION_MS'], DEFAULT_CLAIM_RESERVATION_MS, {
      name: 'HIVE_PRESENCE_CLAIM_RESERVATION_MS',
      min: 1,
    });
  if (senderWindowMs < quietWindowMs) {
    throw new Error(
      `HIVE_WAGGLE_SENDER_WINDOW_MS (${String(senderWindowMs)}) must be >= HIVE_WAGGLE_QUIET_WINDOW_MS (${String(quietWindowMs)})`,
    );
  }

  return {
    quietWindowMs,
    replayDelayMs,
    maxSessionsPerParticipant,
    senderWakeupsPerWindow,
    senderWindowMs,
    claimReservationMs,
  };
}

/**
 * Builds the production notifications subsystem and wires it to Cell Store
 * events. Returns the constructed instances so the bootstrap can expose
 * `presenceRegistry` to the MCP transport (which calls `subscribe`).
 */
export function createNotificationsForProduction(
  deps: NotificationsFactoryDeps,
  options: NotificationsFactoryOptions = {},
): Notifications {
  const config = resolveNotificationsConfig(process.env, options);

  const builder = createBuilder({ cellsRepo: deps.cellsRepo });

  // Forward reference: the registry calls the replay on ready(), and the replay asks
  // the registry whether the stream is still open before delivering.
  let replayRef: Replay | null = null;

  const presenceRegistry = createPresenceRegistry({
    maxSessionsPerParticipant: config.maxSessionsPerParticipant,
    claimReservationMs: config.claimReservationMs,
    logger: deps.logger,
    participantsRepo: deps.participantsRepo,
    onReady: ({ participantId, subscriptionId, handle }) => {
      replayRef?.scheduleReplayFor(participantId, handle, subscriptionId);
    },
  });

  const replay = createReplay(
    {
      cellsRepo: deps.cellsRepo,
      participantsRepo: deps.participantsRepo,
      builder,
      presenceRegistry,
      logger: deps.logger,
    },
    { replayDelayMs: config.replayDelayMs },
  );
  replayRef = replay;

  // Forward reference for the consolidator → pipeline.flushCell wire. The
  // pipeline depends on the consolidator (for `absorb`); the consolidator
  // depends on the pipeline (for `flush`). We resolve the cycle by binding
  // the closure first and assigning the ref after pipeline construction.
  let pipelineRef: Pipeline | null = null;
  const consolidator = createConsolidator(
    { quietWindowMs: config.quietWindowMs },
    async (cellId, absorbedCount) => {
      if (!pipelineRef) {
        // Defensive — should be unreachable: pipelineRef is assigned
        // synchronously two lines below before any timer can fire.
        deps.logger.error(
          { event: 'waggle_consolidator_flush_before_wired', cellId },
          'consolidator fired before pipeline was wired',
        );
        return;
      }
      await pipelineRef.flushCell(cellId, absorbedCount);
    },
  );

  const senderThrottle = createSenderThrottle({
    wakeupsPerWindow: config.senderWakeupsPerWindow,
    windowMs: config.senderWindowMs,
    onDeferredWake: (wake) => {
      void pipelineRef?.handleDeferredWake(wake);
    },
  });

  const pipeline = createPipeline({
    presenceRegistry,
    participantsRepo: deps.participantsRepo,
    cellsRepo: deps.cellsRepo,
    builder,
    consolidator,
    senderThrottle,
    logger: deps.logger,
  });
  pipelineRef = pipeline;

  // Subscribe BEFORE returning — the wiring is synchronous so the first event
  // emitted after this call is observed by the pipeline.
  deps.cellEvents.on('messageStored', (event) => pipeline.handleMessageStored(event));
  deps.cellEvents.on('cellClosed', (event) => pipeline.handleCellClosed(event));

  return {
    presenceRegistry,
    pipeline,
    builder,
    consolidator,
    senderThrottle,
    replay,
    handleParticipantStateChanged({ participantId, newState }) {
      if (newState === 'active') {
        for (const stream of presenceRegistry.listOpenStreams(participantId)) {
          replay.scheduleReplayFor(participantId, stream.handle, stream.subscriptionId);
        }
        return;
      }
      presenceRegistry.closeParticipantStreams(
        participantId,
        newState === 'suspended' ? 'participant_suspended' : 'participant_revoked',
      );
    },
    stop() {
      senderThrottle.stop();
    },
  };
}
