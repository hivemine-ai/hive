import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { Kysely } from 'kysely';

import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { createAuditRepo } from './repository.js';
import {
  createAuditRecorder,
  getAuditRecordFailureCount,
  resetAuditRecordFailureCounters,
  resolveDetailMaxBytes,
} from './recorder.js';
import type { AuditRepo } from './repository.js';
import type { NewAuditEvent } from './types.js';
import type { Logger } from '#observability/logger.js';

interface World {
  db: Kysely<Database>;
  hiveId: string;
  repo: AuditRepo;
}

async function seedWorld(): Promise<World> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);
  const hiveId = uuidv7();
  await db.insertInto('hives').values({ id: hiveId, name: 'h' }).execute();
  return { db, hiveId, repo: createAuditRepo(db) };
}

function silentLogger(): Logger {
  // Minimal pino-shaped stub — vitest captures via the spy, no output to stderr.
  const noop = (): void => undefined;
  const stub = {
    error: vi.fn(noop),
    warn: vi.fn(noop),
    info: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: (): Logger => stub,
    level: 'silent',
  } as unknown as Logger;
  return stub;
}

function newDenialEvent(world: World, overrides: Partial<NewAuditEvent> = {}): NewAuditEvent {
  return {
    category: 'visibility_denial',
    decision: 'deny',
    actorId: uuidv7(),
    actorKind: 'worker',
    subjectId: uuidv7(),
    subjectKind: 'participant',
    reasonCode: 'worker_to_other_owner_worker',
    detail: { senderClass: 'worker', recipientClass: 'other_owner_worker' },
    requestId: null,
    hiveId: world.hiveId,
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('createAuditRecorder', () => {
  let world: World;

  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    world = await seedWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
    resetAuditRecordFailureCounters();
  });

  describe('happy path', () => {
    it('persists a denial event and serializes detail to JSON text', async () => {
      const recorder = createAuditRecorder({ auditRepo: world.repo, logger: silentLogger() });
      const event = newDenialEvent(world);
      await recorder.recordEvent(event);

      const denials = await world.repo.findRecentDenialsBySubject({
        hiveId: world.hiveId,
        subjectId: event.subjectId!,
      });
      expect(denials).toHaveLength(1);
      expect(denials[0]?.category).toBe('visibility_denial');
      expect(denials[0]?.detail).toEqual({
        senderClass: 'worker',
        recipientClass: 'other_owner_worker',
      });
    });

    it('generates id via injected idGen and createdAt via injected clock', async () => {
      const fixedNow = new Date('2026-04-26T10:00:00.000Z');
      const recorder = createAuditRecorder({
        auditRepo: world.repo,
        logger: silentLogger(),
        now: () => fixedNow,
        idGen: () => 'test-id-1',
      });
      const event = newDenialEvent(world);
      await recorder.recordEvent(event);

      const found = await world.repo.findAuditEventById('test-id-1', world.hiveId);
      expect(found).not.toBeNull();
      expect(found?.createdAt.toISOString()).toBe('2026-04-26T10:00:00.000Z');
    });

    it('persists null detail without serialization', async () => {
      const recorder = createAuditRecorder({ auditRepo: world.repo, logger: silentLogger() });
      const event = newDenialEvent(world, { detail: null });
      await recorder.recordEvent(event);

      const denials = await world.repo.findRecentDenialsBySubject({
        hiveId: world.hiveId,
        subjectId: event.subjectId!,
      });
      expect(denials[0]?.detail).toBeNull();
    });
  });

  describe('detail overflow handling', () => {
    it('drops detail when serialized payload exceeds the configured cap; persists row with null detail; logs warning', async () => {
      const logger = silentLogger();
      const recorder = createAuditRecorder({ auditRepo: world.repo, logger });
      const oversize: Record<string, unknown> = { x: 'a'.repeat(5000) };
      const event = newDenialEvent(world, { detail: oversize });
      await recorder.recordEvent(event);

      const denials = await world.repo.findRecentDenialsBySubject({
        hiveId: world.hiveId,
        subjectId: event.subjectId!,
      });
      expect(denials).toHaveLength(1);
      expect(denials[0]?.detail).toBeNull();
      expect(
        (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0);
    });

    it('honors a lower per-recorder cap (cannot exceed schema ceiling)', async () => {
      const logger = silentLogger();
      const recorder = createAuditRecorder(
        { auditRepo: world.repo, logger },
        { detailMaxBytes: 32 },
      );
      const event = newDenialEvent(world, {
        detail: { foo: 'this string is more than thirty-two bytes when serialized' },
      });
      await recorder.recordEvent(event);

      const denials = await world.repo.findRecentDenialsBySubject({
        hiveId: world.hiveId,
        subjectId: event.subjectId!,
      });
      expect(denials[0]?.detail).toBeNull();
    });
  });

  describe('failure-mode contract (DB caída)', () => {
    it('does NOT propagate a DB error to the caller; logs + increments failure counter', async () => {
      const logger = silentLogger();
      const failingRepo: AuditRepo = {
        insertAuditEvent: () => Promise.reject(new Error('simulated DB outage')),
        insertAuditEventBatch: () => Promise.reject(new Error('simulated DB outage')),
        findAuditEventById: () => Promise.resolve(null),
        findRecentDenialsBySubject: () => Promise.resolve([]),
        findAuditEventsByFilter: () => Promise.resolve([]),
      };
      const recorder = createAuditRecorder({ auditRepo: failingRepo, logger });
      const event = newDenialEvent(world);

      // The whole point of this test: must NOT throw.
      await expect(recorder.recordEvent(event)).resolves.toBeUndefined();

      // Counter recorded the failure.
      expect(getAuditRecordFailureCount('visibility_denial')).toBe(1);

      // Stderr structured log received the audit_record_failure entry.
      const errorCalls = (logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(errorCalls.length).toBe(1);
      const [fields] = errorCalls[0] as [Record<string, unknown>, string];
      expect(fields.event).toBe('audit_record_failure');
      expect(fields.category).toBe('visibility_denial');
      expect(fields.errorClass).toBe('Error');
      expect(fields.errorMessage).toBe('simulated DB outage');
    });

    it('CHECK violation (invalid actor combination) does not crash the caller', async () => {
      // Bypass the recorder type-side and force an inconsistent input that the
      // schema CHECK will reject (actor_id NOT NULL with actor_kind 'system').
      const recorder = createAuditRecorder({
        auditRepo: world.repo,
        logger: silentLogger(),
      });
      const event = newDenialEvent(world, {
        actorId: 'a-1',
        actorKind: 'system',
        category: 'admin_purge_run',
        decision: 'success',
      });

      await expect(recorder.recordEvent(event)).resolves.toBeUndefined();
      expect(getAuditRecordFailureCount('admin_purge_run')).toBe(1);
    });
  });

  describe('recordEventBatch', () => {
    it('persists all events in one INSERT', async () => {
      const recorder = createAuditRecorder({ auditRepo: world.repo, logger: silentLogger() });
      const events = [newDenialEvent(world), newDenialEvent(world), newDenialEvent(world)];
      await recorder.recordEventBatch(events);

      const all = await world.repo.findAuditEventsByFilter({
        hiveId: world.hiveId,
        category: 'visibility_denial',
      });
      expect(all).toHaveLength(3);
    });

    it('empty batch is a no-op (no log, no insert)', async () => {
      const logger = silentLogger();
      const recorder = createAuditRecorder({ auditRepo: world.repo, logger });
      await recorder.recordEventBatch([]);
      expect((logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('batch failure: each category counted, each event logged', async () => {
      const logger = silentLogger();
      const failingRepo: AuditRepo = {
        insertAuditEvent: () => Promise.resolve(),
        insertAuditEventBatch: () => Promise.reject(new Error('batch INSERT failed')),
        findAuditEventById: () => Promise.resolve(null),
        findRecentDenialsBySubject: () => Promise.resolve([]),
        findAuditEventsByFilter: () => Promise.resolve([]),
      };
      const recorder = createAuditRecorder({ auditRepo: failingRepo, logger });
      const events = [
        newDenialEvent(world),
        newDenialEvent(world, { category: 'admin_purge_run', decision: 'success' }),
      ];
      await expect(recorder.recordEventBatch(events)).resolves.toBeUndefined();
      expect(getAuditRecordFailureCount('visibility_denial')).toBe(1);
      expect(getAuditRecordFailureCount('admin_purge_run')).toBe(1);
      expect((logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    });
  });
});

describe('resolveDetailMaxBytes', () => {
  const ENV_KEY = 'HIVE_AUDIT_DETAIL_MAX_BYTES';
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('defaults to 4096 when no override is provided', () => {
    expect(resolveDetailMaxBytes()).toBe(4096);
  });

  it('reads from env when present', () => {
    process.env[ENV_KEY] = '2048';
    expect(resolveDetailMaxBytes()).toBe(2048);
  });

  it('config arg wins over env', () => {
    process.env[ENV_KEY] = '2048';
    expect(resolveDetailMaxBytes(1024)).toBe(1024);
  });

  it('clamps at the schema hard ceiling 4096 (cannot be exceeded by env)', () => {
    process.env[ENV_KEY] = '999999';
    expect(resolveDetailMaxBytes()).toBe(4096);
  });

  it('throws on non-positive integer env values', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(() => resolveDetailMaxBytes()).toThrow(/positive integer/);
    process.env[ENV_KEY] = '-5';
    expect(() => resolveDetailMaxBytes()).toThrow(/positive integer/);
    process.env[ENV_KEY] = '0';
    expect(() => resolveDetailMaxBytes()).toThrow(/positive integer/);
  });
});
