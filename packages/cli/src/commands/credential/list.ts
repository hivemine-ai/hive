// `hivectl credential list <participant-ref>` — read-only via direct DB query.
// `participantsRepo` does not expose a `listCredentials` method in Slice 0;
// the SQL is parameterized (no injection risk per tech spec § Seguridad).
// JWT raw is NEVER returned — only metadata.

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { resolveParticipantReference } from '#input/parse-reference.js';
import type { GlobalCliOpts } from '#types.js';

export interface ListCredentialsOpts {
  globals: GlobalCliOpts;
  participantRef: string;
  limit: number | undefined;
}

export interface ListedCredential {
  jti: UUIDv7;
  participantId: UUIDv7;
  kid: string;
  notBefore: Date;
  expiresAt: Date;
  issuedAt: Date;
  isRevoked: boolean;
  revokedAt: Date | null;
}

export async function runListCredentials(
  runtime: CliRuntime,
  opts: ListCredentialsOpts,
): Promise<{ credentials: ListedCredential[] }> {
  const participantId = await resolveParticipantReference(opts.participantRef, runtime);
  const limit = opts.limit ?? 50;

  const rows = await runtime.db
    .selectFrom('credentials')
    .select(['jti', 'participant_id', 'kid', 'not_before', 'expires_at', 'issued_at', 'revoked_at'])
    .where('participant_id', '=', participantId)
    .orderBy('issued_at', 'desc')
    .limit(limit)
    .execute();

  return {
    credentials: rows.map((r) => ({
      jti: r.jti,
      participantId: r.participant_id,
      kid: r.kid,
      notBefore: new Date(r.not_before),
      expiresAt: new Date(r.expires_at),
      issuedAt: new Date(r.issued_at),
      isRevoked: r.revoked_at !== null,
      revokedAt: r.revoked_at !== null ? new Date(r.revoked_at) : null,
    })),
  };
}
