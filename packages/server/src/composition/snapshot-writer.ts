// Composition root: builds the snapshot writer that bridges the server's
// runtime state to the sidecar JSON file consumed by the CLI cold start
// (per [[ADR-022]] + tech spec `[[hivectl Output Layer + Status Snapshot]]`
// § Slice 1).
//
// Three public entry points:
//   - `writeWithServer(serverInfo)` — call after the HTTP host accepts
//     connections. Captures the server block (bind/pid/uptime/version) so
//     subsequent `writeRefresh` calls preserve it.
//   - `writeWithoutServer()`           — call right before graceful shutdown
//     closes the DB. Clears the captured server block AND writes the snapshot
//     with `server: null`.
//   - `writeRefresh()`                 — call from the audit chokepoint and
//     from CLI `stopCli`. Re-reads `hive`/`database`/`lastAudit` from DB and
//     writes a refreshed snapshot, preserving whatever `server` block is
//     authoritative for this process (the captured one if writeWithServer
//     was called; otherwise whatever the on-disk snapshot already held —
//     never blasts a running server's `server: { ... }` to null when called
//     from a co-resident CLI).
//
// All methods are async (DB queries are async); the underlying file write
// is sync (`atomicWriteJson` from `@hive/shared`) — see § "Snapshot atomic
// write — sync vs async" in the tech spec.

import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  HIVE_VERSION,
  type HiveStatusSnapshot,
  atomicWriteJson,
  snapshotPath as defaultSnapshotPath,
} from '@hive/shared';
import type { Kysely } from 'kysely';

import type { UUIDv7 } from '#domain/auth/index.js';
import type { Logger } from '#observability/logger.js';
import type { DbConfig } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';

/** Snapshot heartbeat (seconds). CLI flags stale after `2 × heartbeatSeconds`
 *  per `isStale` policy. With Slice 1 the only refresh triggers are: server
 *  boot, every audit event, and graceful shutdown. Quiet servers may look
 *  stale during low-traffic windows — acceptable for v0.1 (per ADR-022 §
 *  Consecuencias / negativas: snapshot puede estar stale; etiquetado
 *  explícito). A future periodic refresh timer would tighten this.
 */
export const SNAPSHOT_HEARTBEAT_SECONDS = 30;

/** Server `version` field. Re-exported from `@hive/shared` to keep the
 *  on-disk snapshot in lockstep with `hivectl --version` and audit events.
 *  The release.yml workflow rewrites `HIVE_VERSION` in `@hive/shared` before
 *  the SEA bundle, so the published binary reports the actual release tag.
 */
export const SNAPSHOT_HIVE_VERSION = HIVE_VERSION;

export interface ServerSnapshotInfo {
  bind: string;
  pid: number;
  uptimeStartedAt: string;
  version: string;
}

export interface SnapshotWriter {
  writeWithServer(serverInfo: ServerSnapshotInfo): Promise<void>;
  writeWithoutServer(): Promise<void>;
  writeRefresh(): Promise<void>;
}

export interface SnapshotWriterDeps {
  db: Kysely<Database>;
  hiveId: UUIDv7;
  dbConfig: DbConfig;
  logger: Logger;
  /** Override path resolver (test injection). Defaults to `snapshotPath()` */
  pathResolver?: () => string;
  /** Override clock (test injection). Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface HiveCounts {
  name: string;
  colonies: number;
  keepers: number;
  agents: number;
}

export function createSnapshotWriter(deps: SnapshotWriterDeps): SnapshotWriter {
  const pathResolver = deps.pathResolver ?? defaultSnapshotPath;
  const now = deps.now ?? ((): Date => new Date());
  let capturedServer: ServerSnapshotInfo | null = null;

  async function loadHiveCounts(): Promise<HiveCounts | null> {
    const hiveRow = await deps.db
      .selectFrom('hives')
      .select('name')
      .where('id', '=', deps.hiveId)
      .executeTakeFirst();
    if (!hiveRow) return null;
    const [colonies, keepers, agents] = await Promise.all([
      countColonies(deps.db, deps.hiveId),
      countKeepers(deps.db, deps.hiveId),
      countAgents(deps.db, deps.hiveId),
    ]);
    return { name: hiveRow.name, colonies, keepers, agents };
  }

  async function loadLastAudit(): Promise<HiveStatusSnapshot['lastAudit']> {
    const row = await deps.db
      .selectFrom('audit_log')
      .select(['occurred_at', 'category', 'reason_code', 'actor_id', 'actor_kind'])
      .where('hive_id', '=', deps.hiveId)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      at: row.occurred_at,
      event: row.reason_code ?? row.category,
      actor: row.actor_id ?? `system:${row.actor_kind}`,
    };
  }

  function loadDatabaseBlock(): HiveStatusSnapshot['database'] {
    const block: HiveStatusSnapshot['database'] = {
      driver: deps.dbConfig.dialect,
      location: redactDbUrl(deps.dbConfig.url),
    };
    if (deps.dbConfig.dialect === 'sqlite') {
      const sqlitePath = extractSqliteFsPath(deps.dbConfig.url);
      if (sqlitePath !== null) {
        try {
          const stat = statSync(sqlitePath);
          block.sizeBytes = stat.size;
        } catch {
          // File missing or inaccessible — omit sizeBytes silently.
        }
      }
    }
    return block;
  }

  function readDiskSnapshotServer(): HiveStatusSnapshot['server'] {
    const path = pathResolver();
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'v' in parsed &&
        parsed.v === 1 &&
        'server' in parsed
      ) {
        const server = (parsed as { server: HiveStatusSnapshot['server'] }).server;
        if (server === null) return null;
        if (
          typeof server === 'object' &&
          typeof server.bind === 'string' &&
          typeof server.pid === 'number' &&
          typeof server.uptimeStartedAt === 'string' &&
          typeof server.version === 'string'
        ) {
          return server;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async function buildSnapshot(server: HiveStatusSnapshot['server']): Promise<HiveStatusSnapshot> {
    const [hive, lastAudit] = await Promise.all([loadHiveCounts(), loadLastAudit()]);
    const database = loadDatabaseBlock();
    return {
      v: 1,
      writtenAt: now().toISOString(),
      heartbeatSeconds: SNAPSHOT_HEARTBEAT_SECONDS,
      hive,
      server,
      database,
      lastAudit,
    };
  }

  function persist(snapshot: HiveStatusSnapshot): void {
    const path = pathResolver();
    try {
      atomicWriteJson(path, snapshot);
    } catch (err) {
      deps.logger.warn(
        {
          event: 'status_snapshot_write_failed',
          path,
          err: err instanceof Error ? err.message : String(err),
        },
        'snapshot write failed — operator UX may show stale state',
      );
    }
  }

  return {
    async writeWithServer(serverInfo) {
      capturedServer = serverInfo;
      const snapshot = await buildSnapshot(serverInfo);
      persist(snapshot);
    },

    async writeWithoutServer() {
      capturedServer = null;
      const snapshot = await buildSnapshot(null);
      persist(snapshot);
    },

    async writeRefresh() {
      const server = capturedServer ?? readDiskSnapshotServer();
      const snapshot = await buildSnapshot(server);
      persist(snapshot);
    },
  };
}

async function countColonies(db: Kysely<Database>, hiveId: UUIDv7): Promise<number> {
  const row = await db
    .selectFrom('colonies')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('cnt'))
    .where('hive_id', '=', hiveId)
    .executeTakeFirst();
  return Number(row?.cnt ?? 0);
}

async function countKeepers(db: Kysely<Database>, hiveId: UUIDv7): Promise<number> {
  const row = await db
    .selectFrom('hivekeepers')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('cnt'))
    .where('hive_id', '=', hiveId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  return Number(row?.cnt ?? 0);
}

async function countAgents(db: Kysely<Database>, hiveId: UUIDv7): Promise<number> {
  const row = await db
    .selectFrom('agents')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('cnt'))
    .where('hive_id', '=', hiveId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  return Number(row?.cnt ?? 0);
}

function extractSqliteFsPath(url: string): string | null {
  if (!url.startsWith('sqlite:')) return null;
  return url.slice('sqlite:'.length);
}

/**
 * Strip credentials from a DB connection string before persisting it to the
 * status snapshot sidecar. The snapshot is written with default umask (typically
 * world-readable on single-user setups) — embedding a Postgres DSN with
 * `user:password@host` would leak credentials to any local reader of the file.
 *
 * SQLite URLs (`sqlite:./var/db/hive.sqlite`) are passed through unchanged
 * because they carry no credentials. Postgres URLs are parsed via the WHATWG
 * `URL` API so the host/port/database remain intact for operator-facing
 * cold-start UX. Non-standard URLs that fail to parse fall back to
 * `<driver>://<redacted>` rather than throwing — the snapshot must always be
 * writeable so the cold-start shows status.
 */
function redactDbUrl(url: string): string {
  if (url.startsWith('sqlite:')) return url;
  try {
    const parsed = new URL(url);
    if (parsed.password !== '' || parsed.username !== '') {
      parsed.password = '';
      parsed.username = parsed.username !== '' ? '<redacted>' : '';
    }
    return parsed.href;
  } catch {
    const schemeEnd = url.indexOf('://');
    const scheme = schemeEnd >= 0 ? url.slice(0, schemeEnd) : 'db';
    return `${scheme}://<redacted>`;
  }
}
