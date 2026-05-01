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

import type { Kysely } from 'kysely';

import {
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createRevoker,
  createRotator,
  loadAllKeypairs,
  loadBlocklist,
  createVerifier,
} from '#domain/auth/index.js';
import type {
  Blocklist,
  Issuer,
  ParticipantsReadRepo,
  ParticipantsWriteRepo,
  Revoker,
  Rotator,
  SigningKey,
  UUIDv7,
} from '#domain/auth/index.js';
import { createAuditRecorder, createAuditRepo } from '#domain/audit/index.js';
import type { AuditRecorder } from '#domain/audit/index.js';
import {
  createCellsRepo,
  createCellEvents,
  createSender,
  createReader,
} from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';
import { parseIntEnv } from '#observability/env.js';
import type { Logger } from '#observability/logger.js';
import { createDb, resolveDbConfigFromEnv } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';

import { createCellsHookAdapter } from './cells-hook-adapter.js';
import { createNotificationsForProduction } from './notifications-factory.js';
import { createVisibilityEngineForProduction } from './visibility-engine-factory.js';
import { createMcpTransport } from '../transport/mcp/server.js';
import { createHttpHost } from '../transport/mcp/http-host.js';
import type { HttpHost } from '../transport/mcp/http-host.js';

export interface WireConfig {
  /** Default `0.0.0.0`. */
  httpHost?: string;
  /** Default `8443`. */
  httpPort?: number;
  /** Default `/mcp`. */
  mcpPath?: string;
  /** Default 500ms. */
  readyzDbTimeoutMs?: number;
  /** Default 30 seconds. */
  shutdownDrainTimeoutSeconds?: number;
  /** Default `'./keys'`. Where to find the signing keypairs. */
  keysDir?: string;
  /** Default 100. Hard cap server-side for `list_agents.pagination.limit` (PRY-029). */
  listAgentsMaxPageSize?: number;
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
  /** Test/diagnostic — exposes the cell events (asserts wiring). */
  _cellEvents(): ReturnType<typeof createCellEvents>;
}

export function resolveWireConfigFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: WireConfig = {},
): Required<WireConfig> {
  return {
    httpHost: overrides.httpHost ?? env['HIVE_MCP_HTTP_HOST'] ?? '0.0.0.0',
    httpPort:
      overrides.httpPort ??
      parseIntEnv(env['HIVE_MCP_HTTP_PORT'], 8443, {
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
    keysDir: overrides.keysDir ?? env['HIVE_AUTH_KEYS_DIR'] ?? './keys',
    listAgentsMaxPageSize:
      overrides.listAgentsMaxPageSize ??
      parseIntEnv(env['HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE'], 100, {
        name: 'HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE',
        min: 1,
        max: 1000,
      }),
  };
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
  const blocklist = await loadBlocklist(db);

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
  });

  // 3. Cell Store.
  const cellsRepo = createCellsRepo(db);
  const cellEvents = createCellEvents();

  // 4. Visibility Engine (audit recorder built inside the factory).
  const visibilityEngine = createVisibilityEngineForProduction({ db, logger });

  // 5. Sender + Reader.
  const sender = createSender({
    cellsRepo,
    visibilityEngine,
    events: cellEvents,
    db,
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
  //    reads HIVE_WAGGLE_QUIET_WINDOW_MS / HIVE_WAGGLE_REPLAY_DELAY_MS /
  //    HIVE_PRESENCE_* env vars per the spec defaults.
  const notifications = createNotificationsForProduction({
    cellEvents,
    cellsRepo,
    participantsRepo,
    logger,
  });

  // 7. MCP transport.
  const mcpTransport = createMcpTransport({
    verifier,
    participantsRepo,
    cellsRepo,
    sender,
    reader,
    visibilityEngine,
    presenceRegistry: notifications.presenceRegistry,
    logger,
    listAgentsMaxPageSize: cfg.listAgentsMaxPageSize,
  });

  // 8. HTTP host.
  const httpHost = createHttpHost(
    {
      mcpTransport,
      verifier,
      db,
      signingKeysProvider: () => signingKeys.values() as Iterable<SigningKey>,
      logger,
    },
    {
      mcpPath: cfg.mcpPath,
      host: cfg.httpHost,
      port: cfg.httpPort,
      readyzDbTimeoutMs: cfg.readyzDbTimeoutMs,
    },
  );

  return {
    async start() {
      await httpHost.start();
      logger.info(
        { event: 'wire_started', host: cfg.httpHost, port: httpHost.port(), mcpPath: cfg.mcpPath },
        'hive server listening',
      );
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
      const drainMs = Math.max(1, cfg.shutdownDrainTimeoutSeconds) * 1000;
      await stopWithDrainTimeout(httpHost.stop(), drainMs, (err) => {
        logger.error(
          { event: 'wire_stop_failed', err: err instanceof Error ? err.message : String(err) },
          'http host stop failed',
        );
      });
      // Stop the presence sweep timer BEFORE closing the DB — keeps the event
      // loop free of pending intervals during db teardown. Idempotent.
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

    _cellEvents() {
      return cellEvents;
    },
  };
}

async function closeKyselyDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
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
  };
}

export interface CliRuntime {
  db: Kysely<Database>;
  participantsRepo: ParticipantsReadRepo;
  participantsWriteRepo: ParticipantsWriteRepo;
  cellsRepo: CellsRepo;
  blocklist: Blocklist;
  issuer: Issuer;
  rotator: Rotator;
  revoker: Revoker;
  auditRecorder: AuditRecorder;
  signingKeys: Map<string, SigningKey>;
  hiveStableIdentifier: UUIDv7;
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

  const blocklist = await loadBlocklist(db);

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
  const cellsRepo = createCellsRepo(db);
  const cellsHook = createCellsHookAdapter(cellsRepo);
  const participantsWriteRepo = createParticipantsWriteRepo(db, { cellsHook });

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
    snapshotMaxBytes: config.snapshotMaxBytes,
    db,
    logger,
  });
  const revoker = createRevoker({ blocklist, db, logger });

  const auditRepo = createAuditRepo(db);
  const auditRecorder = createAuditRecorder({ auditRepo, logger });

  return {
    db,
    participantsRepo,
    participantsWriteRepo,
    cellsRepo,
    blocklist,
    issuer,
    rotator,
    revoker,
    auditRecorder,
    signingKeys,
    hiveStableIdentifier: hiveRow.id,
    hiveColonyId: colonyRow.id,
    logger,
    config,
  };
}

/** Tear down the CLI runtime. Closes the DB. Idempotent on re-call. */
export async function stopCli(runtime: CliRuntime): Promise<void> {
  await closeKyselyDb(runtime.db);
}
