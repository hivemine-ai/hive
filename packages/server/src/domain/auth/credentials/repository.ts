// Credentials repository — read-only lookups against the `credentials` table.
//
// Per ADR-020 PRY-C — exposes `findActiveCredentialByParticipant`, used by the
// `<participant-ref>:latest` alias resolver to translate a participant
// reference into the JTI of that participant's currently-active credential
// (`hivectl credential rotate/revoke`). Non-credential domain logic (issuer,
// rotator, revoker) keeps querying the table directly via the shared `db`
// handle — they have additional invariants (e.g. blocklist consistency) that
// don't fit a generic read repo.

import type { Kysely } from 'kysely';

import type { Database } from '#persistence/schema.js';
import { isoToDate } from '#persistence/type-mappers.js';
import type { ParticipantKind, UUIDv7 } from '../types.js';

/**
 * Subset of the `credentials` row exposed to callers of the read repo. Mirrors
 * `CredentialMetadata` from `domain/auth/types.ts` but with `notBefore` and
 * `revokedAt` carried through — useful for the resolver and for future read
 * use cases (`hivectl credential list` projection, audit trails).
 */
export interface CredentialRow {
  jti: UUIDv7;
  participantId: UUIDv7;
  participantKind: ParticipantKind;
  kid: string;
  issuedAt: Date;
  notBefore: Date;
  expiresAt: Date;
  isRevoked: boolean;
  revokedAt: Date | null;
}

export interface CredentialsReadRepo {
  /**
   * Returns the most-recent credential for `participantId` that is **active**
   * at the wall-clock instant provided in `now`:
   *   - `revoked_at IS NULL`
   *   - `expires_at > now`
   *   - `participant_id = participantId`
   *   - belongs to a hivekeeper or agent in `hiveId` (cross-hive participants
   *     can never share JTIs because UUID v7 is globally unique, but the
   *     defense-in-depth join enforces multi-Hive scoping for forward-compat
   *     with Hivemine SaaS Phase 2).
   *
   * Defense-in-depth for the v0.1 OSS invariant "at most 1 active credential
   * per participant" (rotate revokes the previous JTI atomically): if the
   * invariant ever breaks (concurrent issuer + rotator without proper TX
   * scoping, future relaxation, etc.) we return the credential with the
   * largest `issued_at`. The PRY-041 test suite covers this edge case
   * explicitly.
   *
   * Returns `null` when:
   *   - `participantId` exists in `hiveId` but has no non-revoked, non-expired
   *     credential (caller maps to `REFERENCE_NOT_FOUND` with subCode
   *     `no_active_credential`).
   *   - `participantId` is unknown to the Hive (caller maps the same way; the
   *     resolver layer typically fails earlier when looking up the participant
   *     by friendly reference).
   */
  findActiveCredentialByParticipant(
    hiveId: UUIDv7,
    participantId: UUIDv7,
    now: Date,
  ): Promise<CredentialRow | null>;
}

export function createCredentialsReadRepo(db: Kysely<Database>): CredentialsReadRepo {
  return {
    async findActiveCredentialByParticipant(hiveId, participantId, now) {
      const nowIso = now.toISOString();
      // LEFT JOIN both possible participant tables so the WHERE clause can
      // OR-filter on either `hk.hive_id` or `ag.hive_id`. The participant_id
      // is unique across hivekeepers and agents (both UUID v7) so at most one
      // join row matches per credential.
      const row = await db
        .selectFrom('credentials as c')
        .leftJoin('hivekeepers as hk', 'hk.id', 'c.participant_id')
        .leftJoin('agents as ag', 'ag.id', 'c.participant_id')
        .select([
          'c.jti',
          'c.participant_id',
          'c.participant_kind',
          'c.kid',
          'c.issued_at',
          'c.not_before',
          'c.expires_at',
          'c.revoked_at',
        ])
        .where('c.participant_id', '=', participantId)
        .where('c.revoked_at', 'is', null)
        .where('c.expires_at', '>', nowIso)
        .where((eb) => eb.or([eb('hk.hive_id', '=', hiveId), eb('ag.hive_id', '=', hiveId)]))
        .orderBy('c.issued_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (!row) return null;
      return {
        jti: row.jti,
        participantId: row.participant_id,
        participantKind: row.participant_kind,
        kid: row.kid,
        issuedAt: isoToDate(row.issued_at),
        notBefore: isoToDate(row.not_before),
        expiresAt: isoToDate(row.expires_at),
        isRevoked: row.revoked_at !== null,
        revokedAt: row.revoked_at ? isoToDate(row.revoked_at) : null,
      };
    },
  };
}
