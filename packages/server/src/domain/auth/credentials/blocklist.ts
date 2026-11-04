// Persistent credential blocklist backed by the credential_revocations table.
//
// The database is the only source of truth: hivectl revokes and rotates from another
// process, so any copy held by the server would miss those writes (INC-2026-008).
// `contains` costs one primary key lookup per verify and, on a database failure,
// rejects instead of answering, so verify fails closed.

import type { Kysely } from 'kysely';

import { dateToIso } from '#persistence/type-mappers.js';
import type { Database } from '#persistence/schema.js';
import type { UUIDv7 } from '../types.js';

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DEFAULT_PURGE_BATCH_SIZE = 1000;

export interface AddRevocationInput {
  jti: UUIDv7;
  credentialExpiresAt: Date;
  revokedBy?: UUIDv7;
  reason?: string;
}

export interface BlocklistOptions {
  /** Must match the verifier: jose accepts a token until `exp + clockTolerance`. */
  clockToleranceSeconds?: number;
  /** Rows deleted per statement by `purgeExpired`. Default 1000. */
  purgeBatchSize?: number;
}

export interface Blocklist {
  /** Primary key lookup, not filtered by expiry. Hot path, called once per verify. */
  contains(jti: UUIDv7): Promise<boolean>;

  /** Idempotent: re-adding the same `jti` is a no-op (ON CONFLICT DO NOTHING). */
  add(input: AddRevocationInput): Promise<void>;

  /**
   * Deletes rows whose credential expired more than the clock tolerance ago, in batches
   * of `purgeBatchSize` so a large backlog never holds one long write lock, and returns
   * how many were removed in total. The margin is what makes purging safe: every deleted row
   * belongs to a token that verify already rejects with CREDENTIAL_EXPIRED.
   */
  purgeExpired(now?: Date): Promise<number>;
}

export function createBlocklist(db: Kysely<Database>, options: BlocklistOptions = {}): Blocklist {
  const toleranceMs = (options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS) * 1000;
  const batchSize = Math.max(1, options.purgeBatchSize ?? DEFAULT_PURGE_BATCH_SIZE);

  return {
    async contains(jti: UUIDv7): Promise<boolean> {
      const row = await db
        .selectFrom('credential_revocations')
        .select('jti')
        .where('jti', '=', jti)
        .executeTakeFirst();
      return row !== undefined;
    },
    async add(input: AddRevocationInput): Promise<void> {
      await db
        .insertInto('credential_revocations')
        .values({
          jti: input.jti,
          revoked_by: input.revokedBy ?? null,
          reason: input.reason ?? null,
          credential_expires_at: dateToIso(input.credentialExpiresAt),
        })
        .onConflict((oc) => oc.column('jti').doNothing())
        .execute();
    },
    async purgeExpired(at: Date = new Date()): Promise<number> {
      const cutoff = dateToIso(new Date(at.getTime() - toleranceMs));
      let total = 0;
      for (;;) {
        const result = await db
          .deleteFrom('credential_revocations')
          .where('jti', 'in', (qb) =>
            qb
              .selectFrom('credential_revocations')
              .select('jti')
              .where('credential_expires_at', '<', cutoff)
              .limit(batchSize),
          )
          .executeTakeFirst();
        const deleted = Number(result.numDeletedRows ?? 0n);
        total += deleted;
        if (deleted < batchSize) return total;
      }
    },
  };
}
