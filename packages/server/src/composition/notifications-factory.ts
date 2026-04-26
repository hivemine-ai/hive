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
  /** Default null (heartbeat disabled — `touch` is no-op). */
  heartbeatTimeoutMs?: number | null;
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

export function resolveNotificationsConfig(
  env: NodeJS.ProcessEnv,
  options: NotificationsFactoryOptions = {},
): Required<Omit<NotificationsFactoryOptions, 'heartbeatTimeoutMs'>> & {
  heartbeatTimeoutMs: number | null;
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
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs !== undefined
      ? options.heartbeatTimeoutMs
      : parseNullableIntEnv(env['HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS'], {
          name: 'HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS',
          min: 0,
        });
  return { quietWindowMs, replayDelayMs, maxSessionsPerParticipant, heartbeatTimeoutMs };
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
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
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

interface ParseIntOptions {
  name: string;
  min: number;
}

function parseIntEnv(value: string | undefined, fallback: number, opts: ParseIntOptions): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`${opts.name} must be an integer (got ${JSON.stringify(value)})`);
  }
  if (parsed < opts.min) {
    throw new Error(`${opts.name} must be >= ${String(opts.min)} (got ${String(parsed)})`);
  }
  return parsed;
}

function parseNullableIntEnv(value: string | undefined, opts: ParseIntOptions): number | null {
  if (value === undefined || value === '' || value === 'null') return null;
  return parseIntEnv(value, 0, opts);
}
