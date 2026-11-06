// PRY-096 (INC-2026-010): upgrade-then-serve. A database left at the v0.2.2 schema makes
// `serve` refuse to boot with exit 4 and the `hivectl migrate up` hint; after
// `migrate up`, `serve` boots, enrollment works and the v0.2.2 data is intact.
// SQLite by default; set HIVE_TEST_PG_URL to run it against Postgres (CI `postgres` job).
// The `public` schema is recreated, so point it at a throwaway database.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_MIGRATIONS,
  createDb,
  createLogger,
  generateKeypair,
  migrateToLatest,
  startCli,
  stopCli,
  uuidv7,
} from '@hive/server';
import type { DbConfig, Wire } from '@hive/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '#program.js';
import { closeRuntime } from '#runtime/lazy-runtime.js';

import { performMigrate } from './migrate.js';
import { runServe } from './serve.js';
import type { SignalsProcess } from './serve.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const PROTOCOL_VERSION = '2026-07-28';
const FIRST_V03 = '20261105120000_enrollment-agents-credentials';
const V02_MIGRATIONS = Object.fromEntries(
  Object.entries(ALL_MIGRATIONS).filter(([name]) => name < FIRST_V03),
);
const V03_NAMES = Object.keys(ALL_MIGRATIONS)
  .filter((name) => name >= FIRST_V03)
  .sort();
const ENV_KEYS = ['HIVE_DB_DIALECT', 'HIVE_DB_URL', 'HIVE_AUTH_KEYS_DIR'];
const GLOBALS = { output: 'json', yes: true, noColor: true, verbose: false } as const;

interface V02World {
  hiveId: string;
  adminId: string;
  agentIds: string[];
}

let workDir: string;
let dbConfig: DbConfig;
let saved: Record<string, string | undefined>;
let wire: Wire | undefined;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry096-upgrade-'));
  dbConfig =
    PG_URL !== undefined && PG_URL !== ''
      ? { dialect: 'postgres', url: PG_URL }
      : { dialect: 'sqlite', url: `sqlite:${path.join(workDir, 'hive.sqlite')}`, sqliteWal: false };
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['HIVE_DB_DIALECT'] = dbConfig.dialect;
  process.env['HIVE_DB_URL'] = dbConfig.url;
  process.env['HIVE_AUTH_KEYS_DIR'] = path.join(workDir, 'keys');
  wire = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRuntime();
  await wire?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(workDir, { recursive: true, force: true });
});

/** A Hive as v0.2.2 left it: its migrations only, rows written with the v0.2.2 columns. */
async function seedV02World(): Promise<V02World> {
  const db = createDb(dbConfig);
  try {
    if (dbConfig.dialect === 'postgres') {
      await db.schema.dropSchema('public').ifExists().cascade().execute();
      await db.schema.createSchema('public').execute();
    }
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });

    const keysDir = path.join(workDir, 'keys');
    await fs.mkdir(keysDir, { recursive: true });
    const key = generateKeypair();
    await fs.writeFile(
      path.join(keysDir, `${key.kid}.private.pem`),
      key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(keysDir, `${key.kid}.public.pem`),
      key.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
    const now = new Date().toISOString();
    const jwk = JSON.stringify(key.publicKey.export({ format: 'jwk' }));
    // Rows carry the v0.2.2 columns only; `as never` bypasses the v0.3 typings where needed.
    await db
      .insertInto('signing_keys')
      .values({ kid: key.kid, algorithm: 'EdDSA', public_jwk: jwk, created_at: now })
      .execute();

    const hiveId = uuidv7();
    const colonyId = uuidv7();
    const adminId = uuidv7();
    await db.insertInto('hives').values({ id: hiveId, name: 'upgrade', created_at: now }).execute();
    await db
      .insertInto('colonies')
      .values({ id: colonyId, hive_id: hiveId, name: 'default', created_at: now })
      .execute();
    await db
      .insertInto('hivekeepers')
      .values({
        id: adminId,
        hive_id: hiveId,
        colony_id: colonyId,
        email: 'keeper@example.com',
        is_admin: 1,
        state: 'active',
        created_at: now,
      } as never)
      .execute();
    const agentIds: string[] = [];
    for (const name of ['worker-a', 'worker-b']) {
      const id = uuidv7();
      agentIds.push(id);
      await db
        .insertInto('agents')
        .values({
          id,
          hive_id: hiveId,
          colony_id: colonyId,
          owner_id: adminId,
          name,
          type: 'worker',
          capabilities: '["cell.send"]',
          state: 'active',
          created_at: now,
        } as never)
        .execute();
    }
    return { hiveId, adminId, agentIds };
  } finally {
    await db.destroy();
  }
}

function fakeProc(): SignalsProcess & { exits: number[] } {
  const exits: number[] = [];
  return {
    exits,
    on() {
      return undefined;
    },
    exit(code) {
      exits.push(code ?? 0);
    },
  };
}

/**
 * Runs `serve` until it either exits or boots. A booted wire is kept for `afterEach`, so a
 * missing guard fails on the assertions instead of hanging.
 */
async function serveUntilExitOrBoot(proc: SignalsProcess, errLines: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    void serve(proc, errLines, (started) => {
      wire = started;
      resolve();
    }).then(resolve);
  });
}

function serve(
  proc: SignalsProcess,
  errLines: string[],
  onWireStarted?: (started: Wire) => void,
): Promise<void> {
  return runServe(
    { port: 0, host: '127.0.0.1', logLevel: undefined, logPretty: undefined, output: 'json' },
    {
      env: { HIVE_MCP_LOG_LEVEL: 'silent' },
      proc,
      readConfigFileFn: () => null,
      readSnapshotFn: () => Promise.resolve(null),
      configPath: path.join(workDir, 'config.json'),
      outSink: () => undefined,
      errSink: (line) => errLines.push(line),
      ...(onWireStarted !== undefined && { onWireStarted }),
    },
  );
}

async function appliedMigrations(): Promise<string[]> {
  const db = createDb(dbConfig);
  try {
    const rows = await db
      .selectFrom('kysely_migration' as never)
      .select(['name'] as never)
      .execute();
    return (rows as { name: string }[]).map((r) => r.name).sort();
  } finally {
    await db.destroy();
  }
}

async function registerSession(baseUrl: string, jwt: string): Promise<{ agent_id: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${jwt}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'register_session',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'register_session',
        arguments: { name: 'claude-upgrade', description: 'Checks the upgrade' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await res.text();
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '{}');
  const body = JSON.parse(json) as {
    result?: { structuredContent: { agent_id: string } };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  return (body.result as { structuredContent: { agent_id: string } }).structuredContent;
}

describe(`upgrade from the v0.2.2 schema then serve (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  it('serve refuses with exit 4 and the migrate hint, writing nothing', async () => {
    await seedV02World();
    const proc = fakeProc();
    const errLines: string[] = [];

    await serveUntilExitOrBoot(proc, errLines);

    expect(wire).toBeUndefined();
    expect(proc.exits).toEqual([4]);
    const stderr = errLines.join('');
    expect(stderr).toMatch(/^error: /);
    expect(stderr).toContain('MIGRATIONS_PENDING');
    for (const name of V03_NAMES) expect(stderr).toContain(name);
    expect(stderr).toContain('back up the database and run `hivectl migrate up`');
    expect(await appliedMigrations()).toEqual(Object.keys(V02_MIGRATIONS).sort());
  });

  it('after migrate up, serve boots, enrollment works and the v0.2.2 data is kept', async () => {
    const world = await seedV02World();
    const refused = fakeProc();
    await serveUntilExitOrBoot(refused, []);
    expect(refused.exits).toEqual([4]);

    const migrated = await performMigrate({ globals: GLOBALS, action: 'up' });
    expect(migrated.applied.map((m) => m.name)).toEqual(V03_NAMES);

    const proc = fakeProc();
    const errLines: string[] = [];
    const started = new Promise<Wire>((resolve) => {
      void serve(proc, errLines, resolve);
    });
    wire = await started;
    expect(proc.exits).toEqual([]);
    expect(errLines).toEqual([]);

    const logger = createLogger({ level: 'silent' });
    const runtime = await startCli({ logger }, {});
    const issued = await runtime.enrollment
      .issueEnrollmentCredential(
        { ownerId: world.adminId },
        { kind: 'system', osUser: 'pry-096', operatorNote: 'upgrade test' },
      )
      .finally(() => stopCli(runtime));
    const registered = await registerSession(`http://127.0.0.1:${String(wire.port())}`, issued.jwt);

    const db = createDb(dbConfig);
    try {
      const agents = await db
        .selectFrom('agents')
        .select(['id', 'name', 'origin'])
        .orderBy('name')
        .execute();
      expect(agents).toEqual([
        { id: registered.agent_id, name: 'claude-upgrade', origin: 'enrollment' },
        { id: world.agentIds[0], name: 'worker-a', origin: 'manual' },
        { id: world.agentIds[1], name: 'worker-b', origin: 'manual' },
      ]);
      const keepers = await db.selectFrom('hivekeepers').select(['id', 'email']).execute();
      expect(keepers).toEqual([{ id: world.adminId, email: 'keeper@example.com' }]);
      const hives = await db.selectFrom('hives').select('id').execute();
      expect(hives).toEqual([{ id: world.hiveId }]);
    } finally {
      await db.destroy();
    }
  }, 20_000);
});

const FUTURE = '29991231000000_from-a-newer-hivectl';
const PENDING_HINT = 'back up the database and run `hivectl migrate up`';
const UNKNOWN_MESSAGE = `the database has migrations unknown to this binary: ${FUTURE}; upgrade hivectl`;

async function migrateFully(): Promise<void> {
  await performMigrate({ globals: GLOBALS, action: 'up' });
}

async function insertUnknownMigration(): Promise<void> {
  const db = createDb(dbConfig);
  try {
    await db
      .insertInto('kysely_migration' as never)
      .values({ name: FUTURE, timestamp: new Date().toISOString() })
      .execute();
  } finally {
    await db.destroy();
  }
}

/** Runs `hivectl <args>` in process and returns its exit code and captured streams. */
async function hivectl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
  try {
    const { program, getExitCode } = buildProgram();
    await program.parseAsync(['node', 'hivectl', ...args]);
    return { code: getExitCode(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    await closeRuntime();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe(`admin commands on an out-of-date schema (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  it('agent list exits 4 with the migrate hint on the v0.2.2 schema', async () => {
    await seedV02World();

    const run = await hivectl(['--output', 'json', 'agent', 'list']);

    expect(run.code).toBe(4);
    expect(run.stderr).toContain('MIGRATIONS_PENDING');
    for (const name of V03_NAMES) expect(run.stderr).toContain(name);
    expect(run.stderr).toContain(PENDING_HINT);
    expect(await appliedMigrations()).toEqual(Object.keys(V02_MIGRATIONS).sort());
  });

  it('credential issue --enrollment exits 4 with the migrate hint on the v0.2.2 schema', async () => {
    await seedV02World();

    const run = await hivectl([
      'credential',
      'issue',
      '--enrollment',
      '--owner',
      'keeper@example.com',
      '--output-credential',
      path.join(workDir, 'enrollment.jwt'),
    ]);

    expect(run.code).toBe(4);
    expect(run.stderr).toContain('MIGRATIONS_PENDING');
    expect(run.stderr).toContain(PENDING_HINT);
    expect(run.stderr).not.toContain('internal error');
  });

  it('agent list works after migrate up and reports origin manual', async () => {
    await seedV02World();
    await migrateFully();

    const run = await hivectl(['--output', 'json', 'agent', 'list']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"origin": "manual"');
  });
});

describe(`a database newer than the binary (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  it('serve exits 4 with the upgrade hint', async () => {
    await seedV02World();
    await migrateFully();
    await insertUnknownMigration();
    const proc = fakeProc();
    const errLines: string[] = [];

    await serveUntilExitOrBoot(proc, errLines);

    expect(wire).toBeUndefined();
    expect(proc.exits).toEqual([4]);
    expect(errLines.join('')).toBe(
      `error: database schema is newer than this hivectl (MIGRATIONS_UNKNOWN): ${UNKNOWN_MESSAGE}\n`,
    );
  });

  it('agent list exits 4 with the upgrade hint', async () => {
    await seedV02World();
    await migrateFully();
    await insertUnknownMigration();

    const run = await hivectl(['agent', 'list']);

    expect(run.code).toBe(4);
    expect(run.stderr).toContain(UNKNOWN_MESSAGE);
  });
});

describe(`migrate status lists pending and unknown migrations (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  it('reports applied, pending and unknown', async () => {
    await seedV02World();
    await insertUnknownMigration();

    const status = await performMigrate({ globals: GLOBALS, action: 'status' });

    expect(status.applied.map((m) => m.name)).toEqual([
      ...Object.keys(V02_MIGRATIONS).sort(),
      FUTURE,
    ]);
    expect(status.pending).toEqual(V03_NAMES);
    expect(status.unknown).toEqual([FUTURE]);
  });

  it('prints pending and unknown in the table output', async () => {
    await seedV02World();
    await insertUnknownMigration();

    const run = await hivectl(['--output', 'table', 'migrate', 'status']);

    expect(run.code).toBe(0);
    for (const name of [...V03_NAMES, FUTURE]) expect(run.stdout).toContain(name);
  });

  it('reports nothing pending once migrated', async () => {
    await seedV02World();
    await migrateFully();

    const status = await performMigrate({ globals: GLOBALS, action: 'status' });

    expect(status.pending).toEqual([]);
    expect(status.unknown).toEqual([]);
  });
});
