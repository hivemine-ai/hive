import type { Kysely } from 'kysely';

import type { Database } from './schema.js';
import { dateToIso } from './type-mappers.js';

export interface AcquireLockOptions {
  lockId: string;
  ownerId: string;
  ttlMs: number;
  // Injectable clock for tests.
  now?: () => Date;
}

/**
 * Tries to acquire a named lock. Returns true on success, false if another
 * active owner holds it. Expired locks (expires_at <= now) are stolen.
 *
 * Replaces `pg_try_advisory_lock` for portability between SQLite and Postgres.
 * The implementation runs in a transaction so the expired-sweep + insert is atomic.
 */
export async function acquireLock(
  db: Kysely<Database>,
  opts: AcquireLockOptions,
): Promise<boolean> {
  const now = opts.now ? opts.now() : new Date();
  const acquiredAt = dateToIso(now);
  const expiresAt = dateToIso(new Date(now.getTime() + opts.ttlMs));

  return db.transaction().execute(async (tx) => {
    // Sweep an expired lock for this lock_id atomically.
    await tx
      .deleteFrom('distributed_locks')
      .where('lock_id', '=', opts.lockId)
      .where('expires_at', '<=', acquiredAt)
      .execute();

    // INSERT ... ON CONFLICT DO NOTHING: a row exists only if a fresh owner holds it.
    const result = await tx
      .insertInto('distributed_locks')
      .values({
        lock_id: opts.lockId,
        owner_id: opts.ownerId,
        acquired_at: acquiredAt,
        expires_at: expiresAt,
      })
      .onConflict((oc) => oc.column('lock_id').doNothing())
      .executeTakeFirst();

    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  });
}

export interface ReleaseLockOptions {
  lockId: string;
  ownerId: string;
}

/**
 * Releases a lock held by `ownerId`. No-op if the row no longer exists or another owner holds it.
 */
export async function releaseLock(db: Kysely<Database>, opts: ReleaseLockOptions): Promise<void> {
  await db
    .deleteFrom('distributed_locks')
    .where('lock_id', '=', opts.lockId)
    .where('owner_id', '=', opts.ownerId)
    .execute();
}

/**
 * Bulk-removes locks whose `expires_at` is on or before `now`.
 * Returns the number of rows deleted.
 */
export async function sweepExpiredLocks(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<number> {
  const result = await db
    .deleteFrom('distributed_locks')
    .where('expires_at', '<=', dateToIso(now))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
