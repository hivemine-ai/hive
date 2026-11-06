// Credential rotator — emits a new credential and atomically blocklists the previous one.
// Per the Auth + Identity tech spec:
//   - Pre-condition: blocklist.contains(currentJti) === false → else CREDENTIAL_ALREADY_REVOKED.
//   - The transaction inserts the new credential row + revocation row in one shot.
//   - A second rotation that lost the race on the same jti rolls back and fails.

import type { Kysely } from 'kysely';

import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso, jsonParse } from '#persistence/type-mappers.js';
import { AuthError } from '../errors.js';
import type { SigningKey } from '#domain/auth/keys/keypair-store.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import type { Duration, IssuedCredential, UUIDv7 } from '../types.js';

import type { Blocklist } from './blocklist.js';
import { mintCredential } from './issuer.js';
import type { MintInput } from './issuer.js';

const DEFAULT_ENROLLMENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface RotateCredentialInput {
  currentJti: UUIDv7;
  ttl?: Duration;
  requestedBy?: UUIDv7;
  reason?: string;
}

export interface RotatorDeps {
  signingKey: SigningKey;
  blocklist: Blocklist;
  hiveStableIdentifier: UUIDv7;
  defaultTtlMs: Duration;
  // ADR-026: default TTL when the rotated credential is an enrollment. Default 90 days.
  enrollmentTtlMs?: Duration;
  snapshotMaxBytes?: number;
  db: Kysely<Database>;
  now?: () => Date;
  logger?: Logger;
}

export interface Rotator {
  rotateCredential(input: RotateCredentialInput): Promise<IssuedCredential>;
}

export function createRotator(deps: RotatorDeps): Rotator {
  const now = deps.now ?? (() => new Date());

  return {
    async rotateCredential(input): Promise<IssuedCredential> {
      // Pre-check: cheap and avoids a transaction on the unhappy path.
      if (await deps.blocklist.contains(input.currentJti)) {
        throw new AuthError('CREDENTIAL_ALREADY_REVOKED');
      }

      // Locate the current credential to derive the participant being rotated.
      const currentRow = await deps.db
        .selectFrom('credentials')
        .select(['participant_id', 'expires_at', 'scope', 'snapshot'])
        .where('jti', '=', input.currentJti)
        .executeTakeFirst();
      if (!currentRow) {
        // No row found: the jti either never existed or was already purged.
        throw new AuthError('CREDENTIAL_ALREADY_REVOKED', {
          subCode: 'credential_not_found',
        });
      }

      const txRepo = createParticipantsReadRepo(deps.db);
      const participant = await txRepo.findById(currentRow.participant_id);
      if (!participant) {
        throw new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
      }
      const state =
        participant.kind === 'hivekeeper' ? participant.hivekeeper.state : participant.agent.state;
      if (state !== 'active') {
        throw new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: state });
      }

      // ADR-026: an enrollment rotates into an enrollment with the same claims.
      const enrollment =
        currentRow.scope === 'enroll' ? enrollmentClaims(currentRow.snapshot) : undefined;
      const issuedAt = now();
      const mintInput: MintInput = {
        participant,
        ttlMs:
          input.ttl ??
          (enrollment ? (deps.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS) : deps.defaultTtlMs),
        issuedBy: input.requestedBy ?? null,
        ...(enrollment ? { enrollment } : {}),
      };

      // Atomic: insert new credential + revoke old in a single transaction.
      const issued = await deps.db.transaction().execute(async (tx) => {
        const credential = await mintCredential(
          {
            signingKey: deps.signingKey,
            hiveStableIdentifier: deps.hiveStableIdentifier,
            db: deps.db,
            now: () => issuedAt,
            ...(deps.snapshotMaxBytes !== undefined
              ? { snapshotMaxBytes: deps.snapshotMaxBytes }
              : {}),
          },
          mintInput,
          tx,
        );

        const revocation = await tx
          .insertInto('credential_revocations')
          .values({
            jti: input.currentJti,
            revoked_by: input.requestedBy ?? null,
            reason: input.reason ?? 'rotation',
            credential_expires_at: currentRow.expires_at,
          })
          .onConflict((oc) => oc.column('jti').doNothing())
          .executeTakeFirst();

        // Two rotations can both pass the pre-check. Exactly one inserts the row;
        // the loser throws here, which rolls back the credential it just inserted.
        if ((revocation.numInsertedOrUpdatedRows ?? 0n) === 0n) {
          throw new AuthError('CREDENTIAL_ALREADY_REVOKED');
        }

        await tx
          .updateTable('credentials')
          .set({ revoked_at: dateToIso(issuedAt) })
          .where('jti', '=', input.currentJti)
          .execute();
        return credential;
      });

      if (deps.logger) {
        deps.logger.info(
          {
            event: 'auth_credential_rotated',
            participantId: issued.participantId,
            previousJti: input.currentJti,
            newJti: issued.jti,
            kid: deps.signingKey.kid,
            expiresAt: dateToIso(issued.expiresAt),
          },
          'auth credential rotated',
        );
      }

      return issued;
    },
  };
}

function enrollmentClaims(snapshot: string): NonNullable<MintInput['enrollment']> {
  const claims = jsonParse<{ name_prefix?: unknown; max_agents?: unknown }>(snapshot);
  return {
    ...(typeof claims.name_prefix === 'string' ? { namePrefix: claims.name_prefix } : {}),
    ...(typeof claims.max_agents === 'number' ? { maxAgents: claims.max_agents } : {}),
  };
}
