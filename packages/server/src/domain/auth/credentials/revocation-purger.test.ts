import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { dateToIso } from '#persistence/type-mappers.js';
import type { Logger } from '#observability/logger.js';
import { createBlocklist } from './blocklist.js';
import { createRevocationPurger } from './revocation-purger.js';

describe('revocation purger', () => {
  let world: SeedWorld;
  const now = new Date('2026-11-03T12:00:00.000Z');

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await destroyWorld(world);
  });

  function logger(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return { info: vi.fn(), warn: vi.fn() } as never;
  }

  async function insert(jti: string, expiresAt: Date): Promise<void> {
    await world.db
      .insertInto('credential_revocations')
      .values({ jti, revoked_by: null, reason: null, credential_expires_at: dateToIso(expiresAt) })
      .execute();
  }

  it('purges expired revocations in batches, keeps live ones and logs the count', async () => {
    const live = uuidv7();
    await insert(live, new Date(now.getTime() + 60_000));
    for (let i = 0; i < 5; i++) await insert(uuidv7(), new Date(now.getTime() - 60_000));
    const log = logger();
    const blocklist = createBlocklist(world.db, { purgeBatchSize: 2, holderProofWindowDays: 0 });
    const purger = createRevocationPurger({
      blocklist,
      logger: log,
      intervalSeconds: 60,
      now: () => now,
    });

    expect(await purger.runOnce()).toBe(5);

    const remaining = await world.db.selectFrom('credential_revocations').select('jti').execute();
    expect(remaining.map((r) => r.jti)).toEqual([live]);
    expect(await blocklist.contains(live)).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_revocations_purged', purged: 5 }),
      expect.any(String),
    );
  });

  it('logs and swallows a database failure', async () => {
    const log = logger();
    const blocklist = {
      ...createBlocklist(world.db),
      purgeExpired: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const purger = createRevocationPurger({ blocklist, logger: log, intervalSeconds: 60 });

    expect(await purger.runOnce()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_revocations_purge_failed', err: 'db down' }),
      expect.any(String),
    );
  });

  it('runs on start and then on every interval until stopped', async () => {
    vi.useFakeTimers();
    const purgeExpired = vi.fn().mockResolvedValue(0);
    const purger = createRevocationPurger({
      blocklist: { ...createBlocklist(world.db), purgeExpired },
      logger: logger(),
      intervalSeconds: 10,
    });

    purger.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgeExpired).toHaveBeenCalledTimes(3);
    purger.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgeExpired).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the interval is 0', async () => {
    vi.useFakeTimers();
    const purgeExpired = vi.fn().mockResolvedValue(0);
    createRevocationPurger({
      blocklist: { ...createBlocklist(world.db), purgeExpired },
      logger: logger(),
      intervalSeconds: 0,
    }).start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpired).not.toHaveBeenCalled();
  });
});
