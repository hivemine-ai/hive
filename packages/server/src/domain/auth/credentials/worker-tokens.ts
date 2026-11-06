// Blocklisting of ADR-026 Worker tokens (credentials rows with `enrolled_via` set).
//
// A Worker token keeps mattering after its `exp`: `verifyRenewalBearer` accepts the last
// one as holder proof for HIVE_HOLDER_PROOF_WINDOW_DAYS more. Supersession, release,
// promotion to Scout and the enrollment revocation cascade therefore all cover every token
// still inside that window, not only the valid ones.

import { sql } from 'kysely';

import type { DbExecutor } from '#domain/auth/participants/cells-hook.js';
import { dateToIso } from '#persistence/type-mappers.js';
import type { UUIDv7 } from '../types.js';

export const DEFAULT_HOLDER_PROOF_WINDOW_DAYS = 7;
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Tokens that expired before the returned instant can no longer serve as holder proof. */
export function holderProofCutoff(
  now: Date,
  windowDays: number = DEFAULT_HOLDER_PROOF_WINDOW_DAYS,
  clockToleranceSeconds: number = DEFAULT_CLOCK_TOLERANCE_SECONDS,
): Date {
  return new Date(now.getTime() - windowDays * DAY_MS - clockToleranceSeconds * 1000);
}

export interface BlocklistWorkerTokensInput {
  // Exactly one selector: the tokens of one Agent, or the child tokens of one enrollment.
  selector: { agentId: UUIDv7 } | { enrolledVia: UUIDv7 };
  expiresAfter: Date;
  reason: string;
  revokedBy: UUIDv7 | null;
}

/**
 * Inserts the selected Worker tokens into the blocklist (ON CONFLICT DO NOTHING) and
 * returns the `jti`s this call added; tokens already listed are not returned.
 */
export async function blocklistWorkerTokens(
  executor: DbExecutor,
  input: BlocklistWorkerTokensInput,
): Promise<UUIDv7[]> {
  const rows = await executor
    .insertInto('credential_revocations')
    .columns(['jti', 'revoked_by', 'reason', 'credential_expires_at'])
    .expression((eb) => {
      let query = eb
        .selectFrom('credentials')
        .select([
          'jti',
          // Casts let Postgres type the bound parameters of the projection.
          sql<string | null>`cast(${input.revokedBy} as text)`.as('revoked_by'),
          sql<string>`cast(${input.reason} as text)`.as('reason'),
          'expires_at',
        ])
        .where('enrolled_via', 'is not', null)
        .where('expires_at', '>', dateToIso(input.expiresAfter));
      query =
        'agentId' in input.selector
          ? query.where('participant_id', '=', input.selector.agentId)
          : query.where('enrolled_via', '=', input.selector.enrolledVia);
      return query;
    })
    .onConflict((oc) => oc.column('jti').doNothing())
    .returning('jti')
    .execute();
  return rows.map((r) => r.jti);
}

export interface HolderProofWindowOptions {
  holderProofWindowDays?: number;
  clockToleranceSeconds?: number;
}

/**
 * Deletes the `credentials` rows of Worker tokens that can no longer serve as holder
 * proof (pass 3 of `runEnrollmentRetention`; the job that schedules it is PRY-094).
 * Returns how many rows were removed.
 */
export async function purgeExpiredWorkerTokens(
  executor: DbExecutor,
  now: Date,
  options: HolderProofWindowOptions = {},
): Promise<number> {
  const result = await executor
    .deleteFrom('credentials')
    .where('enrolled_via', 'is not', null)
    .where(
      'expires_at',
      '<',
      dateToIso(
        holderProofCutoff(now, options.holderProofWindowDays, options.clockToleranceSeconds),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
