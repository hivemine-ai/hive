// Composition root for the Hive v0.1 OSS process.
//
// Builds the dependency graph in normative order, per the manual
// composition-root choice documented in the MCP Server + Tool Surface
// tech spec:
//   1. Env config + DB.
//   2. KeypairStore + Blocklist + Verifier (auth).
//   3. ParticipantsRepo (auth read repo).
//   4. CellsRepo + CellEvents.
//   5. VisibilityEngine (consumes participants + audit).
//   6. Sender + Reader (Cell Store, depend on visibility + events + cellsRepo).
//   7. PresenceRegistry + Waggle pipeline (notifications, depend on cellEvents + cellsRepo + participantsRepo).
//   8. MCP transport (server.ts) — wires verifier + cellStore + presenceRegistry into the SDK.
//   9. HTTP host (fastify) — exposes /mcp, /healthz, /readyz, /.well-known/jwks.json.
//
// `wire.start()` and `wire.stop()` orchestrate boot + graceful shutdown.
//
// `wire.startCli()` (per the hivectl tech spec § "Composition root reusado")
// builds a reduced runtime for the admin CLI: same domain layer, no HTTP/MCP/
// Waggle/timers. Two CLI bootstrap commands (`migrate up`, `init`) bypass it
// entirely — they construct only what they need before the schema or signing
// keys exist. Every other CLI subcommand consumes `startCli()`.

import { HIVE_DEFAULT_HTTP_PORT } from '@hive/shared';
import type { Kysely } from 'kysely';

import {
  createCredentialsReadRepo,
  createIssuer,
  createParticipantStateSignal,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createRevoker,
  createRotator,
  loadAllKeypairs,
  createBlocklist,
  createEnrollment,
  createEnrollmentRetention,
  createRevocationPurger,
  createVerifier,
} from '#domain/auth/index.js';
import type {
  Blocklist,
  CredentialsReadRepo,
  Enrollment,
  Issuer,
  ParticipantsReadRepo,
  ParticipantsWriteRepo,
  Revoker,
  Rotator,
  SigningKey,
  UUIDv7,
} from '#domain/auth/index.js';
import { createAuditRecorder, createAuditRepo } from '#domain/audit/index.js';
import { resolveEnrollmentConfigFromEnv } from './enrollment-config.js';
import type { EnrollmentConfig } from './enrollment-config.js';
import type { AuditRecorder } from '#domain/audit/index.js';
import {
  createCellsRepo,
  createCellEvents,
  createSender,
  createReader,
  DEFAULT_SENDER_CONFIG,
} from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';
import { parseIntEnv } from '#observability/env.js';
import type { Logger } from '#observability/logger.js';
import { createDb, resolveDbConfigFromEnv } from '#persistence/db.js';
import { assertNoPendingMigrations } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { createCellsHookAdapter } from './cells-hook-adapter.js';
import { createEnrollmentRetentionJob } from './enrollment-retention-job.js';
import type { EnrollmentRetentionJob } from './enrollment-retention-job.js';
import { createNotificationsForProduction } from './notifications-factory.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import {
  SNAPSHOT_HIVE_VERSION,
  createSnapshotWriter,
  type SnapshotWriter,
} from './snapshot-writer.js';
import { createVisibilityEngineForProduction } from './visibility-engine-factory.js';
import { createLastConnectedRefresher } from '#transport/mcp/auth-binding.js';
import {
  createRegisterRateLimiter,
  createRejectAlertCounter,
} from '#transport/mcp/enrollment-guards.js';
import { createListenStreams, type ListenStreams } from '#transport/mcp/listen-stream.js';
import { createMcpTransport } from '#transport/mcp/server.js';
import { createHttpHost } from '#transport/mcp/http-host.js';
import type { HttpHost } from '#transport/mcp/http-host.js';

export interface WireConfig {
  /**
   * Worker token TTL of register_session. From HIVE_WORKER_TOKEN_TTL_SECONDS; the
   * override is a test seam that goes below the 60 s floor of the env var.
   */
  workerTokenTtlMs?: number;
  /** Default `0.0.0.0`. */
  httpHost?: string;
  /** Default {@link HIVE_DEFAULT_HTTP_PORT} (`8443`). */
  httpPort?: number;
  /** Default `/mcp`. */
  mcpPath?: string;
  /** Default 500ms. */
  readyzDbTimeoutMs?: number;
  /** Default 30 seconds. */
  shutdownDrainTimeoutSeconds?: number;
  /** Default `'./var/keys'`. Where to find the signing keypairs. */
  keysDir?: string;
  /** Default 100. Hard cap server-side for `list_agents.pagination.limit` (PRY-029). */
  listAgentsMaxPageSize?: number;
  /** From HIVE_MCP_ALLOWED_ORIGINS. Default empty: only clients without Origin pass. */
  allowedOrigins?: string[];
  /** From HIVE_MCP_ALLOWED_HOSTS. Default empty: Host is not validated. */
  allowedHosts?: string[];
  /** From HIVE_LISTEN_KEEPALIVE_INTERVAL_MS. Default 15 s (provisional). */
  listenKeepAliveIntervalMs?: number;
  /** From HIVE_LISTEN_STALL_TIMEOUT_MS. Default 30 s (provisional). */
  listenStallTimeoutMs?: number;
  /**
   * From HIVE_LISTEN_LEASE_MS. Default 60 s. Lease granted to a listen that asks for one
   * (`Hive-Listen-Lease`). 0 disables leases. Must be above the keep-alive interval.
   */
  listenLeaseMs?: number;
  /** From HIVE_MCP_REVERIFY_INTERVAL_SECONDS. Default 60 (provisional). 0 disables it. */
  reverifyIntervalSeconds?: number;
  /** From HIVE_CELL_MAX_UNREAD_PER_SENDER. Default 500 (provisional). */
  maxUnreadPerSender?: number;
  /** From HIVE_AUTH_REVOCATION_PURGE_INTERVAL_SECONDS. Default 3600. 0 disables the purge. */
  revocationPurgeIntervalSeconds?: number;
  /** From HIVE_ENROLLMENT_REGISTER_RATE_LIMIT. Default 30 per window. 0 disables it. */
  enrollmentRegisterRateLimit?: number;
  /** From HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS. Default 60. */
  enrollmentRegisterRateWindowSeconds?: number;
  /** From HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD. Default 5. 0 disables the alert. */
  enrollmentRejectAlertThreshold?: number;
  /** From HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES. Default 10. */
  enrollmentRejectAlertWindowMinutes?: number;
  /** From HIVE_ENROLLMENT_RETENTION_DAYS. Default 30. 0 never retires. */
  enrollmentRetentionDays?: number;
  /** From HIVE_ENROLLMENT_GRACE_DAYS. Default 60. 0 keeps retired Agents indefinitely. */
  enrollmentGraceDays?: number;
  /** From HIVE_ENROLLMENT_RETENTION_INTERVAL_SECONDS. Default 3600. 0 never schedules the job. */
  enrollmentRetentionIntervalSeconds?: number;
}

export interface WireDeps {
  logger: Logger;
}

export interface Wire {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Inspect the bound port (after start). */
  port(): number | null;
  /** Test/diagnostic — exposes the underlying HttpHost (do NOT use in production code). */
  _httpHost(): HttpHost;
  /** Test/diagnostic — a write repo whose state changes reach the state signal. */
  _participantsWriteRepo(): ParticipantsWriteRepo;
  /** Test/diagnostic — exposes the cell events (asserts wiring). */
  _cellEvents(): ReturnType<typeof createCellEvents>;
  /** Test/diagnostic — exposes the presence registry (holder liveness). */
  _presenceRegistry(): PresenceRegistry;
  /** Test/diagnostic — the scheduled enrollment retention job (`runOnce(now)`). */
  _enrollmentRetention(): EnrollmentRetentionJob;
}

export function resolveWireConfigFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: WireConfig = {},
): Required<WireConfig> {
  return {
    workerTokenTtlMs:
      overrides.workerTokenTtlMs ?? resolveEnrollmentConfigFromEnv(env).workerTokenTtlMs,
    enrollmentRegisterRateLimit:
      overrides.enrollmentRegisterRateLimit ??
      parseIntEnv(env['HIVE_ENROLLMENT_REGISTER_RATE_LIMIT'], 30, {
        name: 'HIVE_ENROLLMENT_REGISTER_RATE_LIMIT',
        min: 0,
      }),
    enrollmentRegisterRateWindowSeconds:
      overrides.enrollmentRegisterRateWindowSeconds ??
      parseIntEnv(env['HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS'], 60, {
        name: 'HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS',
        min: 1,
      }),
    enrollmentRejectAlertThreshold:
      overrides.enrollmentRejectAlertThreshold ??
      parseIntEnv(env['HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD'], 5, {
        name: 'HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD',
        min: 0,
      }),
    enrollmentRejectAlertWindowMinutes:
      overrides.enrollmentRejectAlertWindowMinutes ??
      parseIntEnv(env['HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES'], 10, {
        name: 'HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES',
        min: 1,
      }),
    enrollmentRetentionDays:
      overrides.enrollmentRetentionDays ??
      parseIntEnv(env['HIVE_ENROLLMENT_RETENTION_DAYS'], 30, {
        name: 'HIVE_ENROLLMENT_RETENTION_DAYS',
        min: 0,
      }),
    enrollmentGraceDays:
      overrides.enrollmentGraceDays ??
      parseIntEnv(env['HIVE_ENROLLMENT_GRACE_DAYS'], 60, {
        name: 'HIVE_ENROLLMENT_GRACE_DAYS',
        min: 0,
      }),
    enrollmentRetentionIntervalSeconds:
      overrides.enrollmentRetentionIntervalSeconds ??
      parseIntEnv(env['HIVE_ENROLLMENT_RETENTION_INTERVAL_SECONDS'], 3600, {
        name: 'HIVE_ENROLLMENT_RETENTION_INTERVAL_SECONDS',
        min: 0,
      }),
    httpHost: overrides.httpHost ?? env['HIVE_MCP_HTTP_HOST'] ?? '0.0.0.0',
    httpPort:
      overrides.httpPort ??
      parseIntEnv(env['HIVE_MCP_HTTP_PORT'], HIVE_DEFAULT_HTTP_PORT, {
        name: 'HIVE_MCP_HTTP_PORT',
        min: 1,
        max: 65535,
      }),
    mcpPath: overrides.mcpPath ?? env['HIVE_MCP_HTTP_PATH'] ?? '/mcp',
    readyzDbTimeoutMs:
      overrides.readyzDbTimeoutMs ??
      parseIntEnv(env['HIVE_MCP_READYZ_DB_TIMEOUT_MS'], 500, {
        name: 'HIVE_MCP_READYZ_DB_TIMEOUT_MS',
        min: 1,
      }),
    shutdownDrainTimeoutSeconds:
      overrides.shutdownDrainTimeoutSeconds ??
      parseIntEnv(env['HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS'], 30, {
        name: 'HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS',
        min: 1,
      }),
    keysDir: overrides.keysDir ?? env['HIVE_AUTH_KEYS_DIR'] ?? './var/keys',
    listAgentsMaxPageSize:
      overrides.listAgentsMaxPageSize ??
      parseIntEnv(env['HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE'], 100, {
        name: 'HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE',
        min: 1,
        max: 1000,
      }),
    allowedOrigins: overrides.allowedOrigins ?? parseCsvEnv(env['HIVE_MCP_ALLOWED_ORIGINS']),
    allowedHosts:
      overrides.allowedHosts ??
      parseCsvEnv(env['HIVE_MCP_ALLOWED_HOSTS']).map((host) => host.toLowerCase()),
    listenKeepAliveIntervalMs: resolveKeepAliveIntervalMs(env, overrides),
    listenStallTimeoutMs: resolveStallTimeoutMs(env, overrides),
    listenLeaseMs: resolveLeaseMs(env, overrides),
    reverifyIntervalSeconds:
      overrides.reverifyIntervalSeconds ??
      parseIntEnv(env['HIVE_MCP_REVERIFY_INTERVAL_SECONDS'], 60, {
        name: 'HIVE_MCP_REVERIFY_INTERVAL_SECONDS',
        min: 0,
      }),
    revocationPurgeIntervalSeconds:
      overrides.revocationPurgeIntervalSeconds ??
      parseIntEnv(env['HIVE_AUTH_REVOCATION_PURGE_INTERVAL_SECONDS'], 3600, {
        name: 'HIVE_AUTH_REVOCATION_PURGE_INTERVAL_SECONDS',
        min: 0,
      }),
    maxUnreadPerSender:
      overrides.maxUnreadPerSender ??
      parseIntEnv(
        env['HIVE_CELL_MAX_UNREAD_PER_SENDER'],
        DEFAULT_SENDER_CONFIG.maxUnreadPerSender,
        {
          name: 'HIVE_CELL_MAX_UNREAD_PER_SENDER',
          min: 1,
        },
      ),
  };
}

// `hivectl watch` gives up after 45 s without a byte. The server must notice a dead
// stream first, or a reconnecting client would race its own zombie.
const WATCH_SILENCE_MS = 45_000;

function resolveKeepAliveIntervalMs(env: NodeJS.ProcessEnv, overrides: WireConfig): number {
  const intervalMs =
    overrides.listenKeepAliveIntervalMs ??
    parseIntEnv(env['HIVE_LISTEN_KEEPALIVE_INTERVAL_MS'], 15_000, {
      name: 'HIVE_LISTEN_KEEPALIVE_INTERVAL_MS',
      min: 1,
    });
  if (intervalMs >= WATCH_SILENCE_MS) {
    throw new Error(
      `HIVE_LISTEN_KEEPALIVE_INTERVAL_MS must be below ${String(WATCH_SILENCE_MS)}, got ${String(intervalMs)}`,
    );
  }
  return intervalMs;
}

function resolveStallTimeoutMs(env: NodeJS.ProcessEnv, overrides: WireConfig): number {
  const stallMs =
    overrides.listenStallTimeoutMs ??
    parseIntEnv(env['HIVE_LISTEN_STALL_TIMEOUT_MS'], 30_000, {
      name: 'HIVE_LISTEN_STALL_TIMEOUT_MS',
      min: 1,
    });
  if (stallMs >= WATCH_SILENCE_MS) {
    throw new Error(
      `HIVE_LISTEN_STALL_TIMEOUT_MS must be below ${String(WATCH_SILENCE_MS)}, got ${String(stallMs)}`,
    );
  }
  return stallMs;
}

const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
// The client renews every quarter of the lease, so three renewals can be lost before it
// runs out. It never renews faster than every 100 ms, hence the floor.
const MIN_LEASE_MS = 400;

// The lease must also outlast a keep-alive period, or an idle but healthy stream would
// look the same as a dead one to anyone reading the logs. Env and override values go
// through the same checks.
function resolveLeaseMs(env: NodeJS.ProcessEnv, overrides: WireConfig): number {
  const leaseMs =
    overrides.listenLeaseMs ??
    parseIntEnv(env['HIVE_LISTEN_LEASE_MS'], 60_000, { name: 'HIVE_LISTEN_LEASE_MS' });
  if (leaseMs === 0) return 0;
  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new Error(
      `HIVE_LISTEN_LEASE_MS must be an integer of 0 (disabled) or between ${String(MIN_LEASE_MS)} and ${String(MAX_LEASE_MS)}, got ${String(leaseMs)}`,
    );
  }
  const keepAliveMs = resolveKeepAliveIntervalMs(env, overrides);
  if (leaseMs <= keepAliveMs) {
    throw new Error(
      `HIVE_LISTEN_LEASE_MS must be above HIVE_LISTEN_KEEPALIVE_INTERVAL_MS (${String(keepAliveMs)}), got ${String(leaseMs)}`,
    );
  }
  return leaseMs;
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Builds the wire. Does NOT start the HTTP listener — call `wire.start()`
 * after construction. The `db` is constructed inside (one-shot) but exposed
 * via the close hook so `wire.stop()` can end it.
 */
export async function buildWire(deps: WireDeps, overrides: WireConfig = {}): Promise<Wire> {
  const cfg = resolveWireConfigFromEnv(process.env, overrides);
  const { logger } = deps;

  // 1. DB.
  const dbConfig = resolveDbConfigFromEnv();
  const db = createDb(dbConfig);

  // 2. Auth: keypairs + blocklist + verifier.
  const signingKeys = await loadAllKeypairs({ keysDir: cfg.keysDir });
  if (signingKeys.size === 0) {
    throw new Error(
      `No signing keypairs found in ${cfg.keysDir}. Run 'hivectl init' first to bootstrap the Hive.`,
    );
  }
  // INC-2026-010: refuse to serve a schema older than this binary. Read-only check; the
  // operator backs up and runs `hivectl migrate up` (serve never migrates implicitly).
  try {
    await assertNoPendingMigrations(db);
  } catch (err) {
    await db.destroy();
    throw err;
  }
  // ADR-026: revocation rows outlive their token by the holder-proof window.
  const enrollmentConfig = resolveEnrollmentConfigFromEnv(process.env);
  const { holderProofWindowDays } = enrollmentConfig;
  const blocklist = createBlocklist(db, { holderProofWindowDays });
  const revocationPurger = createRevocationPurger({
    blocklist,
    logger,
    intervalSeconds: cfg.revocationPurgeIntervalSeconds,
  });

  const participantsRepo = createParticipantsReadRepo(db, dbConfig.dialect);
  // Resolve hiveId — the verifier needs the canonical hive identifier.
  const hiveRow = await db.selectFrom('hives').select('id').executeTakeFirst();
  if (!hiveRow) {
    throw new Error('No Hive row found. Run hivectl init to bootstrap.');
  }
  const verifier = createVerifier({
    signingKeys,
    blocklist,
    participantsRepo,
    hiveStableIdentifier: hiveRow.id,
    logger,
    // ADR-026: verifyRenewalBearer, the holder proof of a register_session renewal.
    db,
    holderProofWindowDays,
  });

  // 3. Cell Store.
  const cellsRepo = createCellsRepo(db);
  const cellEvents = createCellEvents();

  // 4. Snapshot writer (sidecar JSON for CLI cold start, per ADR-022). Built
  //    BEFORE the visibility engine so the audit chokepoint can refresh the
  //    snapshot per event.
  const snapshotWriter = createSnapshotWriter({
    db,
    hiveId: hiveRow.id,
    dbConfig,
    logger,
  });

  // 5. Visibility Engine (audit recorder built inside the factory). The
  //    `onAuditAfterRecord` hook fires post-commit and refreshes the snapshot
  //    so the CLI cold start sees the latest `lastAudit` block.
  const visibilityEngine = createVisibilityEngineForProduction({
    db,
    logger,
    onAuditAfterRecord: () => snapshotWriter.writeRefresh(),
  });

  // 5. Sender + Reader.
  const sender = createSender({
    cellsRepo,
    visibilityEngine,
    events: cellEvents,
    db,
    config: { dialect: dbConfig.dialect, maxUnreadPerSender: cfg.maxUnreadPerSender },
    onEmitError: (err) =>
      logger.warn(
        { event: 'cell_event_emit_failed', err: err instanceof Error ? err.message : String(err) },
        'cell event listener threw',
      ),
    logger,
  });
  const reader = createReader({ cellsRepo, db, logger });

  // 6. Notifications (Waggle pipeline + Presence Registry) — wires synchronously
  //    to cellEvents BEFORE the HTTP listener accepts requests. The factory
  //    reads the HIVE_WAGGLE_* and HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT env vars
  //    per the spec defaults.
  const notifications = createNotificationsForProduction({
    cellEvents,
    cellsRepo,
    participantsRepo,
    logger,
    hiveId: hiveRow.id,
  });

  // State changes made in this process close or replay streams right away. Changes made
  // by `hivectl`, another process, reach the streams through the re-verification pass.
  const participantStateSignal = createParticipantStateSignal({ logger });
  participantStateSignal.onParticipantStateChanged((change) => {
    notifications.handleParticipantStateChanged(change);
  });
  const participantsWriteRepo = createParticipantsWriteRepo(db, {
    cellsHook: createCellsHookAdapter(cellsRepo),
    stateSignal: participantStateSignal,
  });
  const auditRecorder = createAuditRecorder({
    auditRepo: createAuditRepo(db),
    logger,
    onAfterRecord: () => snapshotWriter.writeRefresh(),
  });

  // ADR-026: the Auth primitives of register_session. New Worker tokens are signed with
  // the active key, as hivectl does.
  const enrollment = createEnrollment({
    signingKey: signingKeys.values().next().value as SigningKey,
    participantsRepo,
    hiveStableIdentifier: hiveRow.id,
    db,
    logger,
    dialect: dbConfig.dialect,
    cellsHook: createCellsHookAdapter(cellsRepo),
    // A revival signals 'active', which replays on the holder's open streams.
    stateSignal: participantStateSignal,
    enrollmentTtlMs: enrollmentConfig.enrollmentTtlMs,
    hiveMaxAgents: enrollmentConfig.hiveMaxAgents,
    workerTokenTtlMs: cfg.workerTokenTtlMs,
    holderProofWindowDays,
  });

  // 7. MCP transport. Forward reference: a renewal re-binds the streams of the listen
  // edge, which is built from the transport's serverInfo.
  let listenStreamsRef: ListenStreams | null = null;
  const mcpTransport = createMcpTransport({
    participantsRepo,
    cellsRepo,
    sender,
    reader,
    visibilityEngine,
    presenceRegistry: notifications.presenceRegistry,
    logger,
    listAgentsMaxPageSize: cfg.listAgentsMaxPageSize,
    enrollment,
    rebindParticipantStreams: (participantId, credential) =>
      listenStreamsRef?.rebindParticipantStreams(participantId, credential) ?? 0,
    rejectAlerts: createRejectAlertCounter({
      threshold: cfg.enrollmentRejectAlertThreshold,
      windowMinutes: cfg.enrollmentRejectAlertWindowMinutes,
    }),
    rejectAlertWindowMinutes: cfg.enrollmentRejectAlertWindowMinutes,
    auditRecorder,
  });

  const listenStreams = createListenStreams({
    cellsRepo,
    presenceRegistry: notifications.presenceRegistry,
    verifier,
    serverInfo: mcpTransport.serverInfo,
    logger,
    keepAliveIntervalMs: cfg.listenKeepAliveIntervalMs,
    stallTimeoutMs: cfg.listenStallTimeoutMs,
    reverifyIntervalSeconds: cfg.reverifyIntervalSeconds,
    leaseMs: cfg.listenLeaseMs > 0 ? cfg.listenLeaseMs : null,
  });
  listenStreamsRef = listenStreams;

  // 13c. ADR-026 enrollment retention job. After the state signal wiring, so its
  // 'retired' and 'revoked' transitions close streams; a live holder is never retired.
  const enrollmentRetention = createEnrollmentRetention({
    db,
    retentionDays: cfg.enrollmentRetentionDays,
    graceDays: cfg.enrollmentGraceDays,
    holderProofWindowDays,
    cellsHook: createCellsHookAdapter(cellsRepo),
    stateSignal: participantStateSignal,
    auditRecorder,
    logger,
  });
  const enrollmentRetentionJob = createEnrollmentRetentionJob({
    run: (now) =>
      enrollmentRetention.runEnrollmentRetention(
        now,
        { kind: 'system' },
        { isHolderLive: (agentId) => notifications.presenceRegistry.isHolderLive(agentId) },
      ),
    intervalSeconds: cfg.enrollmentRetentionIntervalSeconds,
    logger,
  });

  // 8. HTTP host.
  const httpHost = createHttpHost(
    {
      mcpTransport,
      verifier,
      listenEdge: listenStreams,
      lastConnected: createLastConnectedRefresher({ participantsRepo, logger }),
      registerRateLimiter: createRegisterRateLimiter({
        limit: cfg.enrollmentRegisterRateLimit,
        windowSeconds: cfg.enrollmentRegisterRateWindowSeconds,
      }),
      db,
      signingKeysProvider: () => signingKeys.values() as Iterable<SigningKey>,
      logger,
    },
    {
      mcpPath: cfg.mcpPath,
      host: cfg.httpHost,
      port: cfg.httpPort,
      readyzDbTimeoutMs: cfg.readyzDbTimeoutMs,
      allowedOrigins: cfg.allowedOrigins,
      allowedHosts: cfg.allowedHosts,
    },
  );

  return {
    async start() {
      listenStreams.start();
      warnIfAllowedHostsEmpty(logger, cfg.allowedHosts);
      revocationPurger.start();
      enrollmentRetentionJob.start();
      await httpHost.start();
      logger.info(
        { event: 'wire_started', host: cfg.httpHost, port: httpHost.port(), mcpPath: cfg.mcpPath },
        'hive server listening',
      );
      // Snapshot writer: capture server block (bind, pid, uptime, version) and
      // emit the first sidecar JSON. The CLI cold start (Slice 2) reads this
      // file zero-network. If the write fails, the writer logs a warn and the
      // server keeps running — snapshot is best-effort UX, not load-bearing.
      const port = httpHost.port();
      await snapshotWriter.writeWithServer({
        bind: `${cfg.httpHost}:${port ?? cfg.httpPort}`,
        pid: process.pid,
        uptimeStartedAt: new Date().toISOString(),
        version: SNAPSHOT_HIVE_VERSION,
      });
      // One-shot stdout consumer check after the first write went through. If
      // the deploy lacks a stdout consumer (no journald / docker logs driver /
      // sidecar), pino buffers and eventually drops. We surface the issue
      // early instead of having operators discover silent log loss in
      // production. setImmediate gives pino's async write a tick to land plus
      // the stream state to update.
      setImmediate(() => {
        warnIfStdoutConsumerMissing(logger, process.stdout);
      });
    },

    async stop() {
      logger.info({ event: 'wire_stopping' }, 'hive server shutting down');
      // Streams first: a stream is a long POST that would otherwise exhaust the drain.
      try {
        notifications.presenceRegistry.shutdown();
      } catch (err) {
        logger.warn(
          {
            event: 'wire_presence_shutdown_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'presence registry shutdown failed',
        );
      }
      listenStreams.stop();
      revocationPurger.stop();
      notifications.stop();
      const drainMs = Math.max(1, cfg.shutdownDrainTimeoutSeconds) * 1000;
      // Cancels the timer and waits for a run in progress, bounded by the drain.
      await stopWithDrainTimeout(enrollmentRetentionJob.stop(), drainMs, (err) => {
        logger.warn(
          {
            event: 'wire_retention_stop_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'enrollment retention job stop failed',
        );
      });
      await stopWithDrainTimeout(httpHost.stop(), drainMs, (err) => {
        logger.error(
          { event: 'wire_stop_failed', err: err instanceof Error ? err.message : String(err) },
          'http host stop failed',
        );
      });
      // Snapshot writer: clear the server block so the CLI cold start sees
      // `server: null` after a graceful shutdown. Best-effort — failure logs
      // a warn but does not block teardown. SIGKILL bypasses this and leaves
      // a stale snapshot, which the CLI flags via `isStale` (per ADR-022).
      try {
        await snapshotWriter.writeWithoutServer();
      } catch (err) {
        logger.warn(
          {
            event: 'wire_snapshot_shutdown_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'snapshot writeWithoutServer failed during shutdown',
        );
      }
      try {
        await closeKyselyDb(db);
      } catch (err) {
        logger.warn(
          { event: 'wire_db_close_failed', err: err instanceof Error ? err.message : String(err) },
          'db destroy failed',
        );
      }
      logger.info({ event: 'wire_stopped' }, 'hive server stopped');
    },

    port() {
      return httpHost.port();
    },

    _httpHost() {
      return httpHost;
    },

    _participantsWriteRepo() {
      return participantsWriteRepo;
    },

    _cellEvents() {
      return cellEvents;
    },

    _presenceRegistry() {
      return notifications.presenceRegistry;
    },

    _enrollmentRetention() {
      return enrollmentRetentionJob;
    },
  };
}

async function closeKyselyDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}

/**
 * Emits a one-shot `allowed_hosts_empty` warn when `HIVE_MCP_ALLOWED_HOSTS`
 * is empty. An empty list makes the origin guard skip `Host` validation
 * entirely, so a DNS-rebinding request carrying any `Host` value is accepted
 * (Origin is still checked). Behaviour is unchanged; this only surfaces it.
 */
export function warnIfAllowedHostsEmpty(logger: Logger, allowedHosts: readonly string[]): void {
  if (allowedHosts.length === 0) {
    logger.warn(
      { event: 'allowed_hosts_empty', envVar: 'HIVE_MCP_ALLOWED_HOSTS' },
      'HIVE_MCP_ALLOWED_HOSTS is empty: the Host header is not validated, so requests with any Host (including DNS-rebinding attempts) are accepted. Set it to a comma-separated list of the names clients use, for example HIVE_MCP_ALLOWED_HOSTS=hive.example.com',
    );
  }
}

/**
 * Emits a one-shot `stdout_consumer_missing` warn iff the stdout stream is
 * already ended/destroyed when checked. Production callers pass `process.stdout`
 * after the first write has had a chance to flush (post `wire_started`); tests
 * pass a fake stream object.
 */
export function warnIfStdoutConsumerMissing(
  logger: Logger,
  stdout: Pick<NodeJS.WriteStream, 'writableEnded' | 'destroyed'>,
): void {
  if (stdout.writableEnded || stdout.destroyed) {
    logger.warn(
      {
        event: 'stdout_consumer_missing',
        writableEnded: stdout.writableEnded,
        destroyed: stdout.destroyed,
      },
      'stdout has no consumer attached — log lines may be dropped under load',
    );
  }
}

/**
 * Drain `innerStop` with a timeout race. In-race rejects are forwarded to
 * `onError`; post-race rejects are absorbed silently (carry-over PRY-006 F7
 * — without the silent guard, a slow `httpHost.stop()` that rejects after
 * `Promise.race` already returned by timeout escapes as `unhandledRejection`,
 * whose default policy crashes the process in prod).
 *
 * Exported for unit-test access — production callers MUST wrap their own
 * `innerStop` and pass it in.
 */
export async function stopWithDrainTimeout(
  innerStop: Promise<void>,
  drainMs: number,
  onError: (err: unknown) => void,
): Promise<void> {
  // Attach a silent catch synchronously, BEFORE the race awaits, so any
  // rejection (during or after the race) is "handled" from Node's POV. The
  // race below still propagates in-race rejections to `onError`.
  innerStop.catch(() => undefined);

  const race = Promise.race([
    innerStop,
    new Promise<void>((resolve) => setTimeout(() => resolve(), drainMs)),
  ]);
  try {
    await race;
  } catch (err) {
    onError(err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CLI variant — `wire.startCli()` per the hivectl + Admin Operations tech spec.
//
// Builds a reduced runtime: domain repos + auth credentials + audit recorder.
// Skips HTTP, MCP transport, Waggle pipeline, fastify host, all background
// timers. The CLI is short-lived; timers would not get a chance to drain.
//
// `migrate up` and `init` bypass this entirely — they handle DB and key
// material before the wire would have anything to load.
// ───────────────────────────────────────────────────────────────────────────

export interface CliWireConfig {
  /** Default `'./var/keys'`. Where to find the signing keypairs. */
  keysDir?: string;
  /** Default `16384` (16 KB). Snapshot payload cap for issued credentials. */
  snapshotMaxBytes?: number;
  /** Default `31536000000` (365 days in ms). Used when callers omit `ttl`. */
  defaultCredentialTtlMs?: number;
}

export interface CliResolvedConfig {
  keysDir: string;
  snapshotMaxBytes: number;
  defaultCredentialTtlMs: number;
  enrollment: EnrollmentConfig;
}

export function resolveCliConfigFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: CliWireConfig = {},
): CliResolvedConfig {
  const days = parseIntEnv(env['HIVE_AUTH_CREDENTIAL_DEFAULT_TTL_DAYS'], 365, {
    name: 'HIVE_AUTH_CREDENTIAL_DEFAULT_TTL_DAYS',
    min: 1,
  });
  return {
    keysDir: overrides.keysDir ?? env['HIVE_AUTH_KEYS_DIR'] ?? './var/keys',
    snapshotMaxBytes:
      overrides.snapshotMaxBytes ??
      parseIntEnv(env['HIVE_AUTH_SNAPSHOT_MAX_BYTES'], 16384, {
        name: 'HIVE_AUTH_SNAPSHOT_MAX_BYTES',
        min: 1,
      }),
    defaultCredentialTtlMs: overrides.defaultCredentialTtlMs ?? days * 24 * 60 * 60 * 1000,
    enrollment: resolveEnrollmentConfigFromEnv(env),
  };
}

export interface CliRuntime {
  db: Kysely<Database>;
  /**
   * Status snapshot writer (sidecar JSON, per ADR-022). CLI handlers do not
   * call this directly — `stopCli` invokes `writeRefresh` automatically so
   * every command that runs against the runtime refreshes the snapshot at
   * end-of-run. Exposed here for `init` and other bootstrap commands that
   * bypass `stopCli` and need to persist the first snapshot manually.
   */
  snapshotWriter: SnapshotWriter;
  participantsRepo: ParticipantsReadRepo;
  participantsWriteRepo: ParticipantsWriteRepo;
  // Read-only credentials lookups. Today consumed by `resolveCredentialRef`
  // (PRY-041) for the `<participant-ref>:latest` alias in `credential rotate`
  // and `credential revoke`. Future read-only credential surfaces (e.g.
  // `credential list` projection refactor) can land here.
  credentialsRepo: CredentialsReadRepo;
  cellsRepo: CellsRepo;
  blocklist: Blocklist;
  issuer: Issuer;
  rotator: Rotator;
  revoker: Revoker;
  // ADR-026: issue enrollment credentials (`credential issue --enrollment`).
  enrollment: Enrollment;
  auditRecorder: AuditRecorder;
  signingKeys: Map<string, SigningKey>;
  hiveStableIdentifier: UUIDv7;
  // Hive name — read from the same `hives` row as `hiveStableIdentifier`. Used by
  // `parseReference(input, hiveName)` for agent-reference suffix disambiguation
  // per ADR-015 + ADR-020 (single-Hive simplification — CLI cannot thread it via
  // `IdentityContext` because there is no JWT).
  hiveName: string;
  hiveColonyId: UUIDv7;
  logger: Logger;
  config: CliResolvedConfig;
}

/**
 * Build the CLI runtime. Loads the signing keypairs from `keysDir`, opens
 * the DB, builds repos + credential ops + audit recorder, and resolves the
 * canonical hive identifier. Throws if the Hive is not initialized — operator
 * must run `hivectl init` first. Throws if no signing keys are present.
 */
export async function startCli(deps: WireDeps, overrides: CliWireConfig = {}): Promise<CliRuntime> {
  const config = resolveCliConfigFromEnv(process.env, overrides);
  const { logger } = deps;

  const dbConfig = resolveDbConfigFromEnv();
  const db = createDb(dbConfig);

  const signingKeys = await loadAllKeypairs({ keysDir: config.keysDir });
  if (signingKeys.size === 0) {
    throw new Error(
      `No signing keypairs found in ${config.keysDir}. Run 'hivectl init' to bootstrap the Hive.`,
    );
  }
  // Pick any key as the active signing key for newly issued credentials. In
  // Slice 0 there is exactly one key (no rotation yet). When key rotation
  // lands (Slice 1+), the active selection happens here.
  const activeSigningKey = signingKeys.values().next().value as SigningKey;

  const { holderProofWindowDays } = config.enrollment;
  const blocklist = createBlocklist(db, { holderProofWindowDays });

  const hiveRow = await db.selectFrom('hives').select(['id', 'name']).executeTakeFirst();
  if (!hiveRow) {
    throw new Error("No Hive row found. Run 'hivectl init' to bootstrap the Hive.");
  }
  const colonyRow = await db
    .selectFrom('colonies')
    .select('id')
    .where('hive_id', '=', hiveRow.id)
    .executeTakeFirst();
  if (!colonyRow) {
    throw new Error('No default Colony found for the Hive. DB state is inconsistent.');
  }

  const participantsRepo = createParticipantsReadRepo(db, dbConfig.dialect);
  const credentialsRepo = createCredentialsReadRepo(db);
  const cellsRepo = createCellsRepo(db);
  const cellsHook = createCellsHookAdapter(cellsRepo);
  const participantsWriteRepo = createParticipantsWriteRepo(db, {
    cellsHook,
    holderProofWindowDays,
  });

  const issuer = createIssuer({
    signingKey: activeSigningKey,
    participantsRepo,
    hiveStableIdentifier: hiveRow.id,
    defaultTtlMs: config.defaultCredentialTtlMs,
    snapshotMaxBytes: config.snapshotMaxBytes,
    db,
    logger,
  });
  const rotator = createRotator({
    signingKey: activeSigningKey,
    blocklist,
    hiveStableIdentifier: hiveRow.id,
    defaultTtlMs: config.defaultCredentialTtlMs,
    enrollmentTtlMs: config.enrollment.enrollmentTtlMs,
    snapshotMaxBytes: config.snapshotMaxBytes,
    db,
    logger,
  });
  const revoker = createRevoker({ db, logger, cellsHook, holderProofWindowDays });
  const enrollment = createEnrollment({
    signingKey: activeSigningKey,
    participantsRepo,
    hiveStableIdentifier: hiveRow.id,
    snapshotMaxBytes: config.snapshotMaxBytes,
    db,
    logger,
    dialect: dbConfig.dialect,
    cellsHook,
    enrollmentTtlMs: config.enrollment.enrollmentTtlMs,
    hiveMaxAgents: config.enrollment.hiveMaxAgents,
    workerTokenTtlMs: config.enrollment.workerTokenTtlMs,
    holderProofWindowDays,
  });

  const snapshotWriter = createSnapshotWriter({
    db,
    hiveId: hiveRow.id,
    dbConfig,
    logger,
  });

  const auditRepo = createAuditRepo(db);
  const auditRecorder = createAuditRecorder({
    auditRepo,
    logger,
    onAfterRecord: () => snapshotWriter.writeRefresh(),
  });

  return {
    db,
    snapshotWriter,
    participantsRepo,
    participantsWriteRepo,
    credentialsRepo,
    cellsRepo,
    blocklist,
    issuer,
    rotator,
    revoker,
    enrollment,
    auditRecorder,
    signingKeys,
    hiveStableIdentifier: hiveRow.id,
    hiveName: hiveRow.name,
    hiveColonyId: colonyRow.id,
    logger,
    config,
  };
}

/** Tear down the CLI runtime. Refreshes the status snapshot so any audit
 *  events emitted during the command run (or any DB state changes — hive
 *  counts, etc.) land in the sidecar JSON before the DB connection closes.
 *  Best-effort — failure logs a warn and does not block teardown.
 *  Closes the DB. Idempotent on re-call.
 */
export async function stopCli(runtime: CliRuntime): Promise<void> {
  try {
    await runtime.snapshotWriter.writeRefresh();
  } catch (err) {
    runtime.logger.warn(
      {
        event: 'cli_snapshot_refresh_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'snapshot refresh failed during stopCli',
    );
  }
  await closeKyselyDb(runtime.db);
}
