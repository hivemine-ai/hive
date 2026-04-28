// Composition root for the Waggle pipeline + Presence Registry — wires the
// real implementation from its dependencies. The wiring is synchronous and
// MUST complete BEFORE the MCP server accepts its first connection (per the
// tech spec: the first `messageDelivered` is only possible after a
// `sendMessage` from an authenticated client, which requires an accepted MCP
// session, which requires this wiring already in place).
//
// CRITICAL: the event emitter of cellStore MUST preserve sync semantics —
// the race analysis in the Waggle Pipeline + Presence Registry tech spec
// assumes `cellStore.events.emit('messageDelivered', event)` invokes all
// listeners synchronously in the same tick before `emit` returns. The
// in-tree `createCellEvents` (Cell Store) already satisfies this; if it is
// ever swapped for an async-emit lib the race analysis must be revisited.

import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import type { CellEvents, CellsRepo } from '#domain/cells/index.js';
import {
  createBuilder,
  createConsolidator,
  createPipeline,
  createPresenceRegistry,
  createReplay,
} from '#domain/notifications/index.js';
import type {
  Builder,
  Consolidator,
  Pipeline,
  PresenceRegistry,
  Replay,
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
  /**
   * Idle threshold for the periodic sweep. Default 30 min in production. Set
   * to 0 (`HIVE_PRESENCE_IDLE_TIMEOUT_MS=0`) to disable the sweep —
   * backwards-compat with Slice 0 behavior. Per ADR-012.
   */
  idleTimeoutMs?: number | null;
  /**
   * Period of the sweep timer. Default 5 min. Only honored when
   * `idleTimeoutMs > 0`. Per ADR-012.
   */
  sweepIntervalMs?: number;
  /**
   * LRU eviction threshold at cap-hit. Default 15 min. Set to 0 to disable
   * LRU eviction (cap-hit always rejects with `too_many_sessions`). Per
   * ADR-012.
   */
  lruEvictThresholdMs?: number | null;
}

export interface Notifications {
  presenceRegistry: PresenceRegistry;
  pipeline: Pipeline;
  builder: Builder;
  consolidator: Consolidator;
  replay: Replay;
}

const DEFAULT_QUIET_WINDOW_MS = 500;
const DEFAULT_REPLAY_DELAY_MS = 0;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — per ADR-012
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min — per ADR-012
const DEFAULT_LRU_EVICT_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — per ADR-012

export function resolveNotificationsConfig(
  env: NodeJS.ProcessEnv,
  options: NotificationsFactoryOptions = {},
): {
  quietWindowMs: number;
  replayDelayMs: number;
  maxSessionsPerParticipant: number;
  idleTimeoutMs: number | null;
  sweepIntervalMs: number;
  lruEvictThresholdMs: number | null;
} {
  const quietWindowMs =
    options.quietWindowMs ??
    parseIntEnv(env['HIVE_WAGGLE_QUIET_WINDOW_MS'], DEFAULT_QUIET_WINDOW_MS, {
      name: 'HIVE_WAGGLE_QUIET_WINDOW_MS',
      min: 0,
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

  // Idle timeout: explicit null/undefined options preserved; env default
  // applies otherwise. `HIVE_PRESENCE_IDLE_TIMEOUT_MS=0` → null (sweep
  // disabled, backwards-compat with Slice 0).
  const idleTimeoutMs = resolveIdleTimeoutMs(env, options);

  const sweepIntervalMs =
    options.sweepIntervalMs ??
    parseIntEnv(env['HIVE_PRESENCE_SWEEP_INTERVAL_MS'], DEFAULT_SWEEP_INTERVAL_MS, {
      name: 'HIVE_PRESENCE_SWEEP_INTERVAL_MS',
      min: 0,
    });

  const lruEvictThresholdMs = resolveLruThresholdMs(env, options);

  return {
    quietWindowMs,
    replayDelayMs,
    maxSessionsPerParticipant,
    idleTimeoutMs,
    sweepIntervalMs,
    lruEvictThresholdMs,
  };
}

function resolveIdleTimeoutMs(
  env: NodeJS.ProcessEnv,
  options: NotificationsFactoryOptions,
): number | null {
  if (options.idleTimeoutMs !== undefined) return options.idleTimeoutMs;
  const raw = env['HIVE_PRESENCE_IDLE_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = parseIntEnv(raw, DEFAULT_IDLE_TIMEOUT_MS, {
    name: 'HIVE_PRESENCE_IDLE_TIMEOUT_MS',
    min: 0,
  });
  // Treat 0 as "disabled" — backwards-compat path.
  return parsed === 0 ? null : parsed;
}

function resolveLruThresholdMs(
  env: NodeJS.ProcessEnv,
  options: NotificationsFactoryOptions,
): number | null {
  if (options.lruEvictThresholdMs !== undefined) return options.lruEvictThresholdMs;
  const raw = env['HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS'];
  if (raw === undefined || raw === '') return DEFAULT_LRU_EVICT_THRESHOLD_MS;
  const parsed = parseIntEnv(raw, DEFAULT_LRU_EVICT_THRESHOLD_MS, {
    name: 'HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS',
    min: 0,
  });
  return parsed === 0 ? null : parsed;
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

  const replay = createReplay(
    {
      cellsRepo: deps.cellsRepo,
      participantsRepo: deps.participantsRepo,
      builder,
      logger: deps.logger,
    },
    { replayDelayMs: config.replayDelayMs },
  );

  const presenceRegistry = createPresenceRegistry({
    maxSessionsPerParticipant: config.maxSessionsPerParticipant,
    idleTimeoutMs: config.idleTimeoutMs,
    sweepIntervalMs: config.sweepIntervalMs,
    lruEvictThresholdMs: config.lruEvictThresholdMs,
    logger: deps.logger,
    onSubscribed: ({ participantId, subscriptionId, handle }) => {
      replay.scheduleReplayFor(participantId, handle, subscriptionId);
    },
  });

  // Forward reference for the consolidator → pipeline.flushCell wire. The
  // pipeline depends on the consolidator (for `absorb`); the consolidator
  // depends on the pipeline (for `flush`). We resolve the cycle by binding
  // the closure first and assigning the ref after pipeline construction.
  let pipelineRef: Pipeline | null = null;
  const consolidator = createConsolidator(
    { quietWindowMs: config.quietWindowMs },
    async (cellId) => {
      if (!pipelineRef) {
        // Defensive — should be unreachable: pipelineRef is assigned
        // synchronously two lines below before any timer can fire.
        deps.logger.error(
          { event: 'waggle_consolidator_flush_before_wired', cellId },
          'consolidator fired before pipeline was wired',
        );
        return;
      }
      await pipelineRef.flushCell(cellId);
    },
  );

  const pipeline = createPipeline({
    presenceRegistry,
    participantsRepo: deps.participantsRepo,
    cellsRepo: deps.cellsRepo,
    builder,
    consolidator,
    logger: deps.logger,
  });
  pipelineRef = pipeline;

  // Subscribe BEFORE returning — the wiring is synchronous so the first event
  // emitted after this call is observed by the pipeline.
  deps.cellEvents.on('messageDelivered', (event) => pipeline.handleMessageDelivered(event));
  deps.cellEvents.on('cellClosed', (event) => pipeline.handleCellClosed(event));

  return { presenceRegistry, pipeline, builder, consolidator, replay };
}
