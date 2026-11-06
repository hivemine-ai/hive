// Boots the production wire over a real SQLite file with real credentials, for the smoke
// suites of the MCP transport. Not a test file: both suites import it.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import {
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  generateKeypair,
  type CallerContext,
  type ParticipantsWriteRepo,
  type SigningKey,
  type UUIDv7,
} from '#domain/auth/index.js';
import { createCellsRepo } from '#domain/cells/index.js';
import { createCellsHookAdapter } from '#composition/cells-hook-adapter.js';
import { buildWire } from '#composition/wire.js';
import type { Wire, WireConfig } from '#composition/wire.js';
import { createDb, type DbConfig } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { createLogger } from '#observability/logger.js';
import type { Logger } from '#observability/logger.js';

const SYSTEM_CALLER: CallerContext = {
  kind: 'system',
  osUser: 'pry-006-smoke',
  operatorNote: 'pry-006 milestone-18 e2e smoke',
};

export interface SmokeWorld {
  cleanup: () => Promise<void>;
  wire: Wire;
  baseUrl: string;
  dbUrl: string;
  dbConfig: DbConfig;
  hiveId: UUIDv7;
  signingKey: SigningKey;
  jwtA: string;
  jwtB: string;
  jwtAdmin: string;
  adminId: UUIDv7;
  workerAId: UUIDv7;
  workerBId: UUIDv7;
}

export interface SmokeWorldOptions {
  logger?: Logger;
  /** Default 300 s. */
  credentialTtlMs?: number;
  wire?: WireConfig;
  /** Postgres instead of a SQLite file. The `public` schema is dropped and recreated. */
  pgUrl?: string;
}

export async function seedSmokeWorld(opts: SmokeWorldOptions = {}): Promise<SmokeWorld> {
  // ── filesystem & db (real SQLite on disk) ──
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry006-smoke-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
  const keysDir = path.join(workDir, 'keys');
  await fs.mkdir(keysDir, { recursive: true });

  const dbConfig: DbConfig =
    opts.pgUrl !== undefined && opts.pgUrl !== ''
      ? { dialect: 'postgres', url: opts.pgUrl }
      : { dialect: 'sqlite', url: `sqlite:${dbPath}`, sqliteWal: false };
  const db = createDb(dbConfig);
  if (dbConfig.dialect === 'postgres') {
    await sql`drop schema if exists public cascade`.execute(db);
    await sql`create schema public`.execute(db);
  }
  await migrateToLatest(db);

  // ── signing key (real Ed25519) ──
  const signingKey: SigningKey = generateKeypair();
  await db
    .insertInto('signing_keys')
    .values({
      kid: signingKey.kid,
      algorithm: 'EdDSA',
      public_jwk: jsonStringify(signingKey.publicKey.export({ format: 'jwk' })),
      created_at: dateToIso(new Date()),
      retired_at: null,
      removed_at: null,
    })
    .execute();
  // Also persist the keypair to disk for `loadAllKeypairs` in the wire.
  const privatePem = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = signingKey.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.private.pem`), privatePem, {
    mode: 0o600,
  });
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.public.pem`), publicPem);

  // ── hive + colony ──
  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const now = new Date();
  await db
    .insertInto('hives')
    .values({ id: hiveId, name: 'smoke', created_at: dateToIso(now) })
    .execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default', created_at: dateToIso(now) })
    .execute();

  // ── repos with real cells hook (atomicity admin → cell) ──
  const cellsRepo = createCellsRepo(db);
  const cellsHook = createCellsHookAdapter(cellsRepo);
  const writeRepo: ParticipantsWriteRepo = createParticipantsWriteRepo(db, { cellsHook });
  const readRepo = createParticipantsReadRepo(db);

  // ── admin Hivekeeper ──
  const admin = await writeRepo.createHivekeeper(
    {
      hiveId,
      colonyId,
      email: 'admin@smoke.example',
      displayName: 'Smoke Admin',
      isAdmin: true,
    },
    SYSTEM_CALLER,
  );

  // ── workers A and B ──
  const workerA = await writeRepo.createAgent(
    {
      hiveId,
      colonyId,
      ownerId: admin.id,
      name: 'worker-a',
      type: 'worker',
      capabilities: ['cell.send', 'cell.read'],
    },
    SYSTEM_CALLER,
  );
  const workerB = await writeRepo.createAgent(
    {
      hiveId,
      colonyId,
      ownerId: admin.id,
      name: 'worker-b',
      type: 'worker',
      capabilities: ['cell.send', 'cell.read'],
    },
    SYSTEM_CALLER,
  );

  // ── credentials (real JWTs) ──
  const issuer = createIssuer({
    signingKey,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
    defaultTtlMs: opts.credentialTtlMs ?? 300_000,
    db,
  });
  const credA = await issuer.issueCredential({ participantId: workerA.id });
  const credB = await issuer.issueCredential({ participantId: workerB.id });
  const credAdmin = await issuer.issueCredential({ participantId: admin.id });

  // Close the bootstrap-only db handle — the wire opens its own via the same path.
  await db.destroy();

  // ── wire (production composition root) ──
  // Set env so the wire reads from the same DB + keys dir.
  process.env['HIVE_DB_DIALECT'] = dbConfig.dialect;
  process.env['HIVE_DB_URL'] = dbConfig.url;

  const logger = opts.logger ?? createLogger({ level: 'silent' });
  const wire = await buildWire(
    { logger },
    {
      keysDir,
      httpHost: '127.0.0.1',
      httpPort: 0, // ephemeral
      readyzDbTimeoutMs: 1000,
      shutdownDrainTimeoutSeconds: 5,
      ...opts.wire,
    },
  );
  await wire.start();

  const port = wire.port();
  if (port === null) throw new Error('wire failed to bind a port');
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    wire,
    baseUrl,
    dbUrl: dbConfig.url,
    dbConfig,
    hiveId,
    signingKey,
    jwtA: credA.jwt,
    jwtB: credB.jwt,
    jwtAdmin: credAdmin.jwt,
    adminId: admin.id,
    workerAId: workerA.id,
    workerBId: workerB.id,
    cleanup: async () => {
      await wire.stop();
      await fs.rm(workDir, { recursive: true, force: true });
      delete process.env['HIVE_DB_DIALECT'];
      delete process.env['HIVE_DB_URL'];
    },
  };
}
