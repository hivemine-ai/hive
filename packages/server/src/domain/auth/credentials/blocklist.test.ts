import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { createBlocklist } from './blocklist.js';

describe('blocklist', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function insertRevocation(jti: string, expiresAt: Date): Promise<void> {
    await world.db
      .insertInto('credential_revocations')
      .values({
        jti,
        revoked_by: null,
        reason: null,
        credential_expires_at: dateToIso(expiresAt),
      })
      .execute();
  }

  it('contains reads the database, so a row written by another process is seen at once', async () => {
    const blocklist = createBlocklist(world.db);
    const jti = uuidv7();
    expect(await blocklist.contains(jti)).toBe(false);

    await insertRevocation(jti, new Date(Date.now() + 60_000));

    expect(await blocklist.contains(jti)).toBe(true);
  });

  it('contains does not filter by credential_expires_at', async () => {
    const blocklist = createBlocklist(world.db);
    const jti = uuidv7();
    await insertRevocation(jti, new Date(Date.now() - 60_000));

    expect(await blocklist.contains(jti)).toBe(true);
  });

  it('contains propagates a database failure', async () => {
    const blocklist = createBlocklist(world.db);
    await world.db.schema.dropTable('credential_revocations').execute();

    await expect(blocklist.contains(uuidv7())).rejects.toThrow();
  });

  it('add persists the revocation', async () => {
    const blocklist = createBlocklist(world.db);
    const jti = uuidv7();
    await blocklist.add({ jti, credentialExpiresAt: new Date(Date.now() + 60_000) });

    expect(await blocklist.contains(jti)).toBe(true);
    const row = await world.db
      .selectFrom('credential_revocations')
      .selectAll()
      .where('jti', '=', jti)
      .executeTakeFirst();
    expect(row?.jti).toBe(jti);
  });

  it('add is idempotent for the same jti (ON CONFLICT DO NOTHING)', async () => {
    const blocklist = createBlocklist(world.db);
    const jti = uuidv7();
    await blocklist.add({ jti, credentialExpiresAt: new Date(Date.now() + 60_000) });
    await blocklist.add({ jti, credentialExpiresAt: new Date(Date.now() + 60_000) });

    const rows = await world.db
      .selectFrom('credential_revocations')
      .selectAll()
      .where('jti', '=', jti)
      .execute();
    expect(rows.length).toBe(1);
  });

  it('purgeExpired deletes rows past the clock tolerance margin', async () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    const purgeable = uuidv7();
    const live = uuidv7();
    await insertRevocation(purgeable, new Date(now.getTime() - 60_000));
    await insertRevocation(live, new Date(now.getTime() + 60_000));

    const blocklist = createBlocklist(world.db);
    expect(await blocklist.purgeExpired(now)).toBe(1);

    const remaining = await world.db.selectFrom('credential_revocations').selectAll().execute();
    expect(remaining.map((r) => r.jti)).toEqual([live]);
  });

  it('purgeExpired keeps a revocation expired for less than the clock tolerance', async () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    const insideMargin = uuidv7();
    await insertRevocation(insideMargin, new Date(now.getTime() - 4_000));

    const blocklist = createBlocklist(world.db, { clockToleranceSeconds: 5 });
    expect(await blocklist.purgeExpired(now)).toBe(0);
    expect(await blocklist.contains(insideMargin)).toBe(true);
  });

  it('purgeExpired honours a configured clock tolerance', async () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    const jti = uuidv7();
    await insertRevocation(jti, new Date(now.getTime() - 4_000));

    const blocklist = createBlocklist(world.db, { clockToleranceSeconds: 1 });
    expect(await blocklist.purgeExpired(now)).toBe(1);
  });
});
