// Composition root for the Hive v0.1 OSS process.
//
// Builds the dependency graph in normative order (per the MCP Server + Tool
// Surface tech spec § "Decisión: Composition root manual"):
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

import type { Kysely } from 'kysely';

import { createParticipantsReadRepo } from '#domain/auth/index.js';
import { loadAllKeypairs } from '#domain/auth/keys/keypair-store.js';
import type { SigningKey } from '#domain/auth/keys/keypair-store.js';
import { loadBlocklist, createVerifier } from '#domain/auth/index.js';
import {
  createCellsRepo,
  createCellEvents,
  createSender,
  createReader,
} from '#domain/cells/index.js';
import type { Logger } from '#observability/logger.js';
import { createDb } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';

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
    httpPort: overrides.httpPort ?? parseInt(env['HIVE_MCP_HTTP_PORT'] ?? '8443', 10),
    mcpPath: overrides.mcpPath ?? env['HIVE_MCP_HTTP_PATH'] ?? '/mcp',
    readyzDbTimeoutMs:
      overrides.readyzDbTimeoutMs ?? parseInt(env['HIVE_MCP_READYZ_DB_TIMEOUT_MS'] ?? '500', 10),
    shutdownDrainTimeoutSeconds:
      overrides.shutdownDrainTimeoutSeconds ??
      parseInt(env['HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS'] ?? '30', 10),
    keysDir: overrides.keysDir ?? env['HIVE_AUTH_KEYS_DIR'] ?? './keys',
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
  const db = createDb();

  // 2. Auth: keypairs + blocklist + verifier.
  const signingKeys = await loadAllKeypairs({ keysDir: cfg.keysDir });
  if (signingKeys.size === 0) {
    throw new Error(
      `No signing keypairs found in ${cfg.keysDir}. Run 'hivectl init' first to bootstrap the Hive.`,
    );
  }
  const blocklist = await loadBlocklist(db);

  const participantsRepo = createParticipantsReadRepo(db);
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
  });
  const reader = createReader({ cellsRepo, db });

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
    presenceRegistry: notifications.presenceRegistry,
    logger,
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
    },

    async stop() {
      logger.info({ event: 'wire_stopping' }, 'hive server shutting down');
      const drainMs = Math.max(1, cfg.shutdownDrainTimeoutSeconds) * 1000;
      const stopWithTimeout = Promise.race([
        httpHost.stop(),
        new Promise<void>((resolve) => setTimeout(() => resolve(), drainMs)),
      ]);
      try {
        await stopWithTimeout;
      } catch (err) {
        logger.error(
          { event: 'wire_stop_failed', err: err instanceof Error ? err.message : String(err) },
          'http host stop failed',
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
