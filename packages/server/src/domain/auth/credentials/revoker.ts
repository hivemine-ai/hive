// Credential revoker — INSERT into credential_revocations + UPDATE credentials.revoked_at.
// Idempotent: revoking an already-revoked jti is a no-op (no error).

import type { Kysely } from 'kysely';

import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { AuthError } from '../errors.js';
import type { UUIDv7 } from '../types.js';

import type { Blocklist } from './blocklist.js';

export interface RevokeCredentialInput {
  jti: UUIDv7;
  revokedBy?: UUIDv7;
  reason?: string;
}

export interface RevokerDeps {
  blocklist: Blocklist;
  db: Kysely<Database>;
  now?: () => Date;
  logger?: Logger;
}

export interface Revoker {
  revokeCredential(input: RevokeCredentialInput): Promise<void>;
}

export function createRevoker(deps: RevokerDeps): Revoker {
  const now = deps.now ?? (() => new Date());
  return {
    async revokeCredential(input): Promise<void> {
      const credRow = await deps.db
        .selectFrom('credentials')
        .select(['expires_at', 'revoked_at'])
        .where('jti', '=', input.jti)
        .executeTakeFirst();
      if (!credRow) {
        // The operator asked to revoke a jti that never existed. Categorize as an
        // invalid state transition (not as INAUTHENTIC, which is reserved for tokens
        // that fail signature/iss/aud verification at the verifier).
        throw new AuthError('INVALID_STATE_TRANSITION', {
          subCode: 'credential_not_found',
        });
      }
      // Already revoked: idempotent no-op.
      if (credRow.revoked_at !== null) {
        deps.blocklist.recordAdded(input.jti);
        return;
      }

      await deps.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('credential_revocations')
          .values({
            jti: input.jti,
            revoked_by: input.revokedBy ?? null,
            reason: input.reason ?? null,
            credential_expires_at: credRow.expires_at,
          })
          .onConflict((oc) => oc.column('jti').doNothing())
          .execute();

        await tx
          .updateTable('credentials')
          .set({ revoked_at: dateToIso(now()) })
          .where('jti', '=', input.jti)
          .execute();
      });

      deps.blocklist.recordAdded(input.jti);

      if (deps.logger) {
        deps.logger.info(
          { event: 'auth_credential_revoked', jti: input.jti },
          'auth credential revoked',
        );
      }
    },
  };
}
