import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { loadBlocklist } from './blocklist.js';

describe('blocklist', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('boot preloads non-expired revocations only', async () => {
    const futureExpiry = new Date(Date.now() + 60_000);
    const pastExpiry = new Date(Date.now() - 60_000);
    const expiredJti = uuidv7();
    const liveJti = uuidv7();

    await world.db
      .insertInto('credential_revocations')
      .values({
        jti: expiredJti,
        revoked_by: null,
        reason: null,
        credential_expires_at: dateToIso(pastExpiry),
      })
      .execute();
    await world.db
      .insertInto('credential_revocations')
      .values({
        jti: liveJti,
        revoked_by: null,
        reason: null,
        credential_expires_at: dateToIso(futureExpiry),
      })
      .execute();

    const blocklist = await loadBlocklist(world.db);
    expect(blocklist.contains(liveJti)).toBe(true);
    expect(blocklist.contains(expiredJti)).toBe(false);
    expect(blocklist.size()).toBe(1);
  });

  it('add inserts a row and mutates the in-memory Set', async () => {
    const blocklist = await loadBlocklist(world.db);
    const jti = uuidv7();
    expect(blocklist.contains(jti)).toBe(false);
    await blocklist.add({
      jti,
      credentialExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(blocklist.contains(jti)).toBe(true);
    expect(blocklist.size()).toBe(1);

    // Persisted in DB.
    const row = await world.db
      .selectFrom('credential_revocations')
      .selectAll()
      .where('jti', '=', jti)
      .executeTakeFirst();
    expect(row?.jti).toBe(jti);
  });

  it('add is idempotent for the same jti (ON CONFLICT DO NOTHING)', async () => {
    const blocklist = await loadBlocklist(world.db);
    const jti = uuidv7();
    await blocklist.add({
      jti,
      credentialExpiresAt: new Date(Date.now() + 60_000),
    });
    await blocklist.add({
      jti,
      credentialExpiresAt: new Date(Date.now() + 60_000),
    });
    const rows = await world.db
      .selectFrom('credential_revocations')
      .selectAll()
      .where('jti', '=', jti)
      .execute();
    expect(rows.length).toBe(1);
    expect(blocklist.size()).toBe(1);
  });

  it('purgeExpired deletes expired rows from DB', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const expiredJti = uuidv7();
    const liveJti = uuidv7();

    await world.db
      .insertInto('credential_revocations')
      .values({
        jti: expiredJti,
        revoked_by: null,
        reason: null,
        credential_expires_at: dateToIso(past),
      })
      .execute();
    await world.db
      .insertInto('credential_revocations')
      .values({
        jti: liveJti,
        revoked_by: null,
        reason: null,
        credential_expires_at: dateToIso(future),
      })
      .execute();

    const blocklist = await loadBlocklist(world.db);
    const purged = await blocklist.purgeExpired();
    expect(purged).toBe(1);

    const remaining = await world.db.selectFrom('credential_revocations').selectAll().execute();
    expect(remaining.map((r) => r.jti)).toEqual([liveJti]);
  });
});
