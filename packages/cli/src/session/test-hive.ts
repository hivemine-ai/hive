// A real Hive for the proxy tests: `hivectl init` on a temporary SQLite file, an
// enrollment credential issued through the CLI runtime, and the production wire
// listening on a fixed loopback port (so it can be stopped and started again at
// the same URL). Not a test file: the proxy suites import it.

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildWire, createDb, createLogger, startCli, stopCli } from '@hive/server';
import type { AuditEventCategory, Wire } from '@hive/server';

import { runInit } from '#commands/init.js';

export interface HiveWorldOptions {
  /** Lifetime of the Worker tokens register_session issues. */
  workerTokenTtlMs?: number;
  /** Listen lease the server grants (ADR-025). */
  listenLeaseMs?: number;
}

export interface HiveWorld {
  /** MCP endpoint. */
  url: string;
  enrollmentCredential: string;
  workDir: string;
  isOnline(agentId: string): boolean;
  streamCount(agentId: string): number;
  auditCount(category: AuditEventCategory): Promise<number>;
  /** Stops the server; the URL stays reserved for {@link start}. */
  stop(): Promise<void>;
  start(): Promise<void>;
  cleanup(): Promise<void>;
}

const ENV_KEYS = ['HIVE_DB_DIALECT', 'HIVE_DB_URL', 'HIVE_AUTH_KEYS_DIR', 'HIVE_MCP_LOG_LEVEL'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function startHiveWorld(options: HiveWorldOptions = {}): Promise<HiveWorld> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-proxy-world-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
  const keysDir = path.join(workDir, 'keys');
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['HIVE_DB_DIALECT'] = 'sqlite';
  process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
  process.env['HIVE_AUTH_KEYS_DIR'] = keysDir;
  process.env['HIVE_MCP_LOG_LEVEL'] = 'silent';

  const init = await runInit({
    globals: { output: 'json', yes: true, noColor: true, verbose: false },
    adminEmail: 'leo@example.com',
    adminDisplayName: 'Leo',
    hiveName: 'proxyhive',
    db: `sqlite:${dbPath}`,
    keysDir,
    ttl: '365d',
    outputCredential: path.join(workDir, 'admin.jwt'),
  });

  const logger = createLogger({ level: 'silent' });
  const runtime = await startCli({ logger }, { keysDir });
  const issued = await runtime.enrollment.issueEnrollmentCredential(
    { ownerId: init.adminId },
    { kind: 'system', osUser: 'proxy-test', operatorNote: 'proxy test enrollment' },
  );
  await stopCli(runtime);

  const port = await freePort();
  let wire: Wire | undefined;

  const start = async (): Promise<void> => {
    wire = await buildWire(
      { logger },
      {
        keysDir,
        httpHost: '127.0.0.1',
        httpPort: port,
        readyzDbTimeoutMs: 1000,
        shutdownDrainTimeoutSeconds: 1,
        ...(options.workerTokenTtlMs !== undefined && {
          workerTokenTtlMs: options.workerTokenTtlMs,
        }),
        ...(options.listenLeaseMs !== undefined && { listenLeaseMs: options.listenLeaseMs }),
      },
    );
    await wire.start();
  };
  const stop = async (): Promise<void> => {
    const current = wire;
    wire = undefined;
    await current?.stop();
  };
  await start();

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    enrollmentCredential: issued.jwt,
    workDir,
    isOnline: (agentId) => wire?._presenceRegistry().getPresence(agentId).online ?? false,
    streamCount: (agentId) => wire?._presenceRegistry().getPresence(agentId).streamCount ?? 0,
    auditCount: async (category) => {
      const db = createDb({ dialect: 'sqlite', url: `sqlite:${dbPath}`, sqliteWal: false });
      try {
        const rows = await db
          .selectFrom('audit_log')
          .select('id')
          .where('category', '=', category)
          .execute();
        return rows.length;
      } finally {
        await db.destroy();
      }
    },
    stop,
    start,
    cleanup: async () => {
      await stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fs.rm(workDir, { recursive: true, force: true });
    },
  };
}
