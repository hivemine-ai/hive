// Integration tests for the wire ↔ snapshot writer wiring (PRY-048 Slice 1).
// Boots a real `buildWire` against an in-memory-equivalent SQLite + tmp keys
// dir + custom XDG_STATE_HOME so the snapshot lands in a controlled path.
//
// The 3 hooks asserted:
//   1. `wire.start()` writes the snapshot with `server: { bind, pid, ... }`.
//   2. The audit chokepoint refresh — covered by `recorder.test.ts`
//      `onAfterRecord` tests (per the visibility engine factory's wiring).
//      This file omits the audit-event integration assertion to keep the
//      end-to-end setup focused; the recorder unit tests are the canonical
//      proof of the chokepoint hook.
//   3. `wire.stop()` writes the snapshot with `server: null`.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { generateKeypair, type SigningKey } from '#domain/auth/keys/keypair-store.js';
import { createDb, type DbConfig } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { createLogger } from '#observability/logger.js';

import { buildWire, type Wire } from './wire.js';

interface SmokeWorld {
  cleanup: () => Promise<void>;
  wire: Wire;
  snapshotFile: string;
}

async function bootWire(): Promise<SmokeWorld> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry048-wire-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
  const keysDir = path.join(workDir, 'keys');
  const xdgState = path.join(workDir, 'state');
  await fs.mkdir(keysDir, { recursive: true });

  const dbConfig: DbConfig = {
    dialect: 'sqlite',
    url: `sqlite:${dbPath}`,
    sqliteWal: false,
  };
  const db = createDb(dbConfig);
  await migrateToLatest(db);

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
  const privatePem = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = signingKey.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.private.pem`), privatePem, {
    mode: 0o600,
  });
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.public.pem`), publicPem);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const now = new Date();
  await db
    .insertInto('hives')
    .values({ id: hiveId, name: 'snapshot-wire-test', created_at: dateToIso(now) })
    .execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default', created_at: dateToIso(now) })
    .execute();

  await db.destroy();

  process.env['HIVE_DB_DIALECT'] = 'sqlite';
  process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
  process.env['XDG_STATE_HOME'] = xdgState;

  const logger = createLogger({ level: 'silent' });
  const wire = await buildWire(
    { logger },
    {
      keysDir,
      httpHost: '127.0.0.1',
      httpPort: 0,
      readyzDbTimeoutMs: 1000,
      shutdownDrainTimeoutSeconds: 5,
    },
  );

  return {
    wire,
    snapshotFile: path.join(xdgState, 'hive', 'status.json'),
    cleanup: async () => {
      await fs.rm(workDir, { recursive: true, force: true });
      delete process.env['HIVE_DB_DIALECT'];
      delete process.env['HIVE_DB_URL'];
      delete process.env['XDG_STATE_HOME'];
    },
  };
}

describe('wire ↔ snapshot writer integration (PRY-048)', () => {
  let world: SmokeWorld;

  beforeEach(async () => {
    world = await bootWire();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  it('wire.start() writes a snapshot with the captured server block', async () => {
    await world.wire.start();
    try {
      const raw = await fs.readFile(world.snapshotFile, 'utf8');
      const snap = JSON.parse(raw) as {
        v: number;
        server: { bind: string; pid: number; uptimeStartedAt: string; version: string } | null;
        hive: { name: string } | null;
      };
      expect(snap.v).toBe(1);
      expect(snap.server).not.toBeNull();
      expect(snap.server!.pid).toBe(process.pid);
      expect(snap.server!.bind).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(snap.server!.bind.endsWith(':0')).toBe(false);
      expect(snap.hive!.name).toBe('snapshot-wire-test');
    } finally {
      await world.wire.stop();
    }
  });

  it('wire.stop() writes a snapshot with server: null after a graceful shutdown', async () => {
    await world.wire.start();
    await world.wire.stop();

    const raw = await fs.readFile(world.snapshotFile, 'utf8');
    const snap = JSON.parse(raw) as {
      server: unknown;
      writtenAt: string;
    };
    expect(snap.server).toBeNull();
    expect(typeof snap.writtenAt).toBe('string');
    expect(Date.parse(snap.writtenAt)).not.toBeNaN();
  });

  it('shutdown writtenAt is later than boot writtenAt', async () => {
    await world.wire.start();
    const bootRaw = await fs.readFile(world.snapshotFile, 'utf8');
    const bootSnap = JSON.parse(bootRaw) as { writtenAt: string };

    // Wait long enough for the ISO timestamp millisecond to advance.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await world.wire.stop();
    const stopRaw = await fs.readFile(world.snapshotFile, 'utf8');
    const stopSnap = JSON.parse(stopRaw) as { writtenAt: string; server: unknown };

    expect(Date.parse(stopSnap.writtenAt)).toBeGreaterThan(Date.parse(bootSnap.writtenAt));
    expect(stopSnap.server).toBeNull();
  });
});
