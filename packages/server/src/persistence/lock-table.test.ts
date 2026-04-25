import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import { acquireLock, releaseLock, sweepExpiredLocks } from './lock-table.js';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import type { Kysely } from 'kysely';

describe('lock-table primitive', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
    await migrateToLatest(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('first owner acquires the lock; second concurrent owner is rejected', async () => {
    const ok1 = await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-A',
      ttlMs: 60_000,
    });
    const ok2 = await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-B',
      ttlMs: 60_000,
    });
    expect(ok1).toBe(true);
    expect(ok2).toBe(false);
  });

  it('releaseLock by the holder lets a new owner acquire it', async () => {
    await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-A',
      ttlMs: 60_000,
    });
    await releaseLock(db, { lockId: 'job:expiration', ownerId: 'worker-A' });
    const ok = await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-B',
      ttlMs: 60_000,
    });
    expect(ok).toBe(true);
  });

  it('releaseLock from a non-holder is a no-op', async () => {
    await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-A',
      ttlMs: 60_000,
    });
    await releaseLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-B',
    });
    const ok = await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-C',
      ttlMs: 60_000,
    });
    expect(ok).toBe(false);
  });

  it('an expired lock is stolen by the next acquirer', async () => {
    const t0 = new Date('2026-04-25T12:00:00Z');
    const tExpired = new Date(t0.getTime() + 1_000); // 1s after expiry (ttl 100ms below)

    await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-A',
      ttlMs: 100,
      now: () => t0,
    });

    const ok = await acquireLock(db, {
      lockId: 'job:expiration',
      ownerId: 'worker-B',
      ttlMs: 60_000,
      now: () => tExpired,
    });
    expect(ok).toBe(true);
  });

  it('sweepExpiredLocks deletes only expired rows', async () => {
    const t0 = new Date('2026-04-25T12:00:00Z');

    await acquireLock(db, {
      lockId: 'lock-fresh',
      ownerId: 'a',
      ttlMs: 60_000,
      now: () => t0,
    });
    await acquireLock(db, {
      lockId: 'lock-expired',
      ownerId: 'b',
      ttlMs: 100,
      now: () => t0,
    });

    const swept = await sweepExpiredLocks(db, new Date(t0.getTime() + 1_000));
    expect(swept).toBe(1);

    // Fresh lock should still be held: a new owner cannot acquire.
    const stillHeld = await acquireLock(db, {
      lockId: 'lock-fresh',
      ownerId: 'c',
      ttlMs: 60_000,
      now: () => new Date(t0.getTime() + 1_000),
    });
    expect(stillHeld).toBe(false);
  });

  it('serial calls from the same owner re-acquire as no-op (already held)', async () => {
    const ok1 = await acquireLock(db, {
      lockId: 'lock',
      ownerId: 'owner',
      ttlMs: 60_000,
    });
    const ok2 = await acquireLock(db, {
      lockId: 'lock',
      ownerId: 'owner',
      ttlMs: 60_000,
    });
    // Conflict-do-nothing: second call sees an existing fresh row and returns false.
    // The owner can simply continue — they already hold it.
    expect(ok1).toBe(true);
    expect(ok2).toBe(false);
  });
});
