import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HiveStatusSnapshot } from '@hive/shared';

import { seedWorld, destroyWorld, type SeedWorld } from '#domain/auth/test-helpers.js';
import { createLogger } from '#observability/logger.js';

import {
  SNAPSHOT_HEARTBEAT_SECONDS,
  SNAPSHOT_HIVE_VERSION,
  createSnapshotWriter,
  type ServerSnapshotInfo,
} from './snapshot-writer.js';

function readSnapshotFile(path: string): HiveStatusSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as HiveStatusSnapshot;
}

const SAMPLE_SERVER: ServerSnapshotInfo = {
  bind: '127.0.0.1:8443',
  pid: 12345,
  uptimeStartedAt: '2026-05-03T12:00:00.000Z',
  version: SNAPSHOT_HIVE_VERSION,
};

describe('createSnapshotWriter', () => {
  let world: SeedWorld;
  let tmpDir: string;
  let snapshotFile: string;

  beforeEach(async () => {
    world = await seedWorld();
    tmpDir = mkdtempSync(join(tmpdir(), 'snap-writer-test-'));
    snapshotFile = join(tmpDir, 'status.json');
  });

  afterEach(async () => {
    await destroyWorld(world);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeWithServer writes a v:1 snapshot with the captured server block + DB-derived hive counts', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithServer(SAMPLE_SERVER);
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.v).toBe(1);
    expect(snap.heartbeatSeconds).toBe(SNAPSHOT_HEARTBEAT_SECONDS);
    expect(snap.server).toEqual(SAMPLE_SERVER);
    expect(snap.hive).toEqual({
      name: 'Test Hive',
      colonies: 1,
      keepers: 2,
      agents: 2,
    });
    expect(snap.lastAudit).toBeNull();
    expect(snap.database.driver).toBe('sqlite');
    expect(typeof snap.writtenAt).toBe('string');
    expect(Date.parse(snap.writtenAt)).not.toBeNaN();
  });

  it('writeWithoutServer writes a snapshot with server: null', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.server).toBeNull();
    expect(snap.hive).not.toBeNull();
  });

  it('writeRefresh after writeWithServer preserves the captured server block', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithServer(SAMPLE_SERVER);
    await writer.writeRefresh();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.server).toEqual(SAMPLE_SERVER);
  });

  it('writeRefresh on a clean disk (no captured server, no prior file) writes server: null', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeRefresh();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.server).toBeNull();
  });

  it('writeRefresh from a fresh writer with a prior server block on disk preserves that server block', async () => {
    // Simulate the CLI flow: a different process (the server) wrote the
    // snapshot with `server: { ... }`. Now a CLI command starts a fresh
    // writer (no captured server) and refreshes — must NOT blast `server`
    // to null. This is the protective behaviour against co-resident server
    // + CLI overwriting each other's `server` block.
    const writer1 = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });
    await writer1.writeWithServer(SAMPLE_SERVER);

    const writer2 = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });
    await writer2.writeRefresh();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.server).toEqual(SAMPLE_SERVER);
  });

  it('writeWithoutServer clears the captured server so a subsequent writeRefresh writes server: null', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithServer(SAMPLE_SERVER);
    await writer.writeWithoutServer();
    await writer.writeRefresh();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.server).toBeNull();
  });

  it('lastAudit reflects the most recent audit_log row when present', async () => {
    // Insert a deterministic audit row directly via DB.
    await world.db
      .insertInto('audit_log')
      .values({
        id: '01900000-0000-7000-8000-000000000001',
        hive_id: world.hiveId,
        occurred_at: '2026-05-03T12:34:56.789Z',
        category: 'admin_credential_issue',
        decision: 'allow',
        actor_id: world.adminHivekeeperId,
        actor_kind: 'hivekeeper',
        subject_id: null,
        subject_kind: null,
        reason_code: 'credential.issued',
        detail: null,
        request_id: null,
      })
      .execute();

    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });
    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.lastAudit).toEqual({
      at: '2026-05-03T12:34:56.789Z',
      event: 'credential.issued',
      actor: world.adminHivekeeperId,
    });
  });

  it('writtenAt uses the injected clock', async () => {
    const fixed = new Date('2026-05-03T15:00:00.000Z');
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
      now: () => fixed,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.writtenAt).toBe('2026-05-03T15:00:00.000Z');
  });

  it('database.driver reflects the resolved dbConfig', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite:./var/db/hive.sqlite' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.database.driver).toBe('sqlite');
    expect(snap.database.location).toBe('sqlite:./var/db/hive.sqlite');
  });

  it('keepers count excludes revoked hivekeepers', async () => {
    // Revoke the non-admin keeper.
    await world.db
      .updateTable('hivekeepers')
      .set({ state: 'revoked', revoked_at: '2026-05-03T11:00:00.000Z' })
      .where('id', '=', world.nonAdminHivekeeperId)
      .execute();

    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    // 2 keepers seeded, 1 revoked → only the admin remains active.
    expect(snap.hive?.keepers).toBe(1);
  });

  it('agents count excludes revoked agents', async () => {
    // Revoke the worker.
    await world.db
      .updateTable('agents')
      .set({ state: 'revoked', revoked_at: '2026-05-03T11:00:00.000Z' })
      .where('id', '=', world.workerAgentId)
      .execute();

    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: world.hiveId,
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    // 2 agents seeded (worker + scout), 1 revoked → only scout remains.
    expect(snap.hive?.agents).toBe(1);
  });

  it('hive returns null when no Hive row exists for the configured hiveId', async () => {
    const writer = createSnapshotWriter({
      db: world.db,
      hiveId: '01900000-0000-7000-8000-000000000999',
      dbConfig: { dialect: 'sqlite', url: 'sqlite::memory:' },
      logger: createLogger({ level: 'silent' }),
      pathResolver: () => snapshotFile,
    });

    await writer.writeWithoutServer();
    const snap = readSnapshotFile(snapshotFile);

    expect(snap.hive).toBeNull();
  });
});
