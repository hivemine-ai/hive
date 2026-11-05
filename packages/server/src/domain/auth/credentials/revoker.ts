// Credential revoker — INSERT into credential_revocations + UPDATE credentials.revoked_at.
// Idempotent: revoking an already-revoked jti is a no-op (no error).
//
// ADR-026: revoking an enrollment credential (scope 'enroll') cascades in the same
// transaction. Every child Worker token still valid or inside the holder-proof window goes
// into the blocklist (reason 'enrollment_revoked'), and with `revokeAgents` its Agents go
// straight to `revoked`. The cascade runs even when the enrollment is already listed (for
// instance rotated, then revoked after a leak), and a 'rotation' row is overwritten with
// the caller's reason so a later renewal can tell "rotated" from "revoked".

import type { Kysely } from 'kysely';

import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { noopCellsHook } from '#domain/auth/participants/cells-hook.js';
import type { CellsRepoHook } from '#domain/auth/participants/cells-hook.js';
import type { ParticipantStateSignal } from '#domain/auth/participants/state-signal.js';
import { AuthError } from '../errors.js';
import type { UUIDv7 } from '../types.js';

import { blocklistWorkerTokens, holderProofCutoff } from './worker-tokens.js';

export interface RevokeCredentialInput {
  jti: UUIDv7;
  revokedBy?: UUIDv7;
  reason?: string;
  // Only for enrollment credentials: also revoke the Agents registered through it.
  revokeAgents?: boolean;
}

export interface RevokeCredentialResult {
  revokedTokenJtis: UUIDv7[];
  revokedAgentIds: UUIDv7[];
}

export interface RevokerDeps {
  db: Kysely<Database>;
  now?: () => Date;
  logger?: Logger;
  // The Cell of every Agent revoked by the cascade closes, as in revokeAgent.
  cellsHook?: CellsRepoHook;
  // Post-commit signal, one emit per Agent revoked by the cascade.
  stateSignal?: ParticipantStateSignal;
  holderProofWindowDays?: number;
  clockToleranceSeconds?: number;
}

export interface Revoker {
  revokeCredential(input: RevokeCredentialInput): Promise<RevokeCredentialResult>;
}

const NOTHING: RevokeCredentialResult = { revokedTokenJtis: [], revokedAgentIds: [] };

export function createRevoker(deps: RevokerDeps): Revoker {
  const now = deps.now ?? (() => new Date());
  const cellsHook = deps.cellsHook ?? noopCellsHook;
  return {
    async revokeCredential(input): Promise<RevokeCredentialResult> {
      const credRow = await deps.db
        .selectFrom('credentials')
        .select(['expires_at', 'revoked_at', 'scope'])
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
      const isEnrollment = credRow.scope === 'enroll';
      if (input.revokeAgents === true && !isEnrollment) {
        throw new AuthError('INVALID_INPUT', { subCode: 'revoke_agents_requires_enrollment' });
      }
      // Already revoked: idempotent no-op, except for the enrollment cascade.
      if (credRow.revoked_at !== null && !isEnrollment) return NOTHING;

      const at = now();
      const revokedBy = input.revokedBy ?? null;
      const reason = input.reason ?? null;
      const result = await deps.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('credential_revocations')
          .values({
            jti: input.jti,
            revoked_by: revokedBy,
            reason,
            credential_expires_at: credRow.expires_at,
          })
          .onConflict((oc) =>
            isEnrollment
              ? oc
                  .column('jti')
                  .doUpdateSet({ reason, revoked_by: revokedBy })
                  .where('credential_revocations.reason', '=', 'rotation')
              : oc.column('jti').doNothing(),
          )
          .execute();

        await tx
          .updateTable('credentials')
          .set({ revoked_at: dateToIso(at) })
          .where('jti', '=', input.jti)
          .where('revoked_at', 'is', null)
          .execute();

        if (!isEnrollment) return NOTHING;

        const revokedTokenJtis = await blocklistWorkerTokens(tx, {
          selector: { enrolledVia: input.jti },
          expiresAfter: holderProofCutoff(
            at,
            deps.holderProofWindowDays,
            deps.clockToleranceSeconds,
          ),
          reason: 'enrollment_revoked',
          revokedBy,
        });

        let revokedAgentIds: UUIDv7[] = [];
        if (input.revokeAgents === true) {
          const revoked = await tx
            .updateTable('agents')
            .set({ state: 'revoked', revoked_at: dateToIso(at), retired_at: null })
            .where('enrolled_via', '=', input.jti)
            .where('origin', '=', 'enrollment')
            .where('state', 'in', ['active', 'retired', 'suspended'])
            .returning('id')
            .execute();
          revokedAgentIds = revoked.map((r) => r.id);
          for (const ownerId of revokedAgentIds) {
            await cellsHook.closeCell(tx, { ownerId });
          }
        }
        return { revokedTokenJtis, revokedAgentIds };
      });

      for (const participantId of result.revokedAgentIds) {
        deps.stateSignal?.emit({ participantId, newState: 'revoked' });
      }
      if (deps.logger) {
        deps.logger.info(
          {
            event: 'auth_credential_revoked',
            jti: input.jti,
            ...(isEnrollment
              ? {
                  revokedTokens: result.revokedTokenJtis.length,
                  revokedAgents: result.revokedAgentIds.length,
                }
              : {}),
          },
          'auth credential revoked',
        );
      }
      return result;
    },
  };
}
