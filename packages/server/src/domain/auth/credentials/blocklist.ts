// Credential blocklist — in-memory Set + persistent table.
// Per the Auth + Identity tech spec:
//   - The hot path (`contains`) is a synchronous Set lookup, called once per request.
//   - Mutations (`add`) go to Postgres/SQLite first; only on success do we mutate the Set
//     (DB is the source of truth).
//   - At boot, the Set is preloaded from rows whose credential_expires_at > now —
//     expired rows do not need to live in memory because step 3 of the verifier already
//     rejects expired tokens with CREDENTIAL_EXPIRED.

import type { Kysely } from 'kysely';

import { dateToIso } from '../../../persistence/type-mappers.js';
import type { Database } from '../../../persistence/schema.js';
import type { UUIDv7 } from '../types.js';

export interface AddRevocationInput {
  jti: UUIDv7;
  credentialExpiresAt: Date;
  revokedBy?: UUIDv7;
  reason?: string;
}

export interface Blocklist {
  /** O(1) sync lookup. Hot path called once per verify. */
  contains(jti: UUIDv7): boolean;

  /**
   * Persists the revocation in the DB and mutates the in-memory Set on success.
   * Idempotent: re-adding the same `jti` is a no-op (ON CONFLICT DO NOTHING).
   */
  add(input: AddRevocationInput): Promise<void>;

  /**
   * Bulk-deletes rows whose credential has expired. Returns the number of rows removed.
   * The in-memory Set is NOT mutated for performance — expired tokens fail the verifier's
   * step 3 (exp check) before ever reaching the blocklist test, so over-reporting is harmless.
   */
  purgeExpired(now?: Date): Promise<number>;

  /** Test helper: returns the current in-memory Set size. */
  size(): number;
}

/**
 * Boot the blocklist: read non-expired revocations from DB into a Set, then return the
 * stateful object. The caller owns the lifecycle.
 */
export async function loadBlocklist(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<Blocklist> {
  const set = new Set<string>();
  const rows = await db
    .selectFrom('credential_revocations')
    .select('jti')
    .where('credential_expires_at', '>', dateToIso(now))
    .execute();
  for (const r of rows) set.add(r.jti);

  return {
    contains(jti: UUIDv7): boolean {
      return set.has(jti);
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
      set.add(input.jti);
    },
    async purgeExpired(at: Date = new Date()): Promise<number> {
      const result = await db
        .deleteFrom('credential_revocations')
        .where('credential_expires_at', '<=', dateToIso(at))
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0n);
    },
    size(): number {
      return set.size;
    },
  };
}
