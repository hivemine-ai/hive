// Credential rotator — emits a new credential and atomically blocklists the previous one.
// Per the Auth + Identity tech spec:
//   - Pre-condition: blocklist.contains(currentJti) === false → else CREDENTIAL_ALREADY_REVOKED.
//   - The transaction inserts the new credential row + revocation row in one shot.
//   - On commit, the in-memory Set is updated via `blocklist.recordAdded(currentJti)`.

import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import * as jose from 'jose';

import type { Database, JsonText } from '../../../persistence/schema.js';
import { dateToIso, jsonStringify, validateJsonText } from '../../../persistence/type-mappers.js';
import { AuthError } from '../errors.js';
import type { SigningKey } from '../keys/keypair-store.js';
import { createParticipantsReadRepo } from '../participants/repository.js';
import type { Duration, IssuedCredential, ParticipantKind, UUIDv7 } from '../types.js';

import type { Blocklist } from './blocklist.js';

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
  snapshotMaxBytes?: number;
  db: Kysely<Database>;
  now?: () => Date;
}

export interface Rotator {
  rotateCredential(input: RotateCredentialInput): Promise<IssuedCredential>;
}

export function createRotator(deps: RotatorDeps): Rotator {
  const snapshotMaxBytes = deps.snapshotMaxBytes ?? 16 * 1024;
  const now = deps.now ?? (() => new Date());

  return {
    async rotateCredential(input): Promise<IssuedCredential> {
      // Pre-check: cheap and avoids a transaction on the unhappy path.
      if (deps.blocklist.contains(input.currentJti)) {
        throw new AuthError('CREDENTIAL_ALREADY_REVOKED');
      }

      // Locate the current credential to derive the participant being rotated.
      const currentRow = await deps.db
        .selectFrom('credentials')
        .select(['participant_id', 'expires_at'])
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

      const issuedAt = now();
      const newJti = uuidv7();
      const ttlMs = input.ttl ?? deps.defaultTtlMs;
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);
      const iat = Math.floor(issuedAt.getTime() / 1000);
      const exp = Math.floor(expiresAt.getTime() / 1000);

      const kind: ParticipantKind =
        participant.kind === 'hivekeeper' ? 'hivekeeper' : participant.agent.type;
      const participantId =
        participant.kind === 'hivekeeper' ? participant.hivekeeper.id : participant.agent.id;
      const hiveId =
        participant.kind === 'hivekeeper'
          ? participant.hivekeeper.hiveId
          : participant.agent.hiveId;
      const colonyId =
        participant.kind === 'hivekeeper'
          ? participant.hivekeeper.colonyId
          : participant.agent.colonyId;

      const payload: jose.JWTPayload & {
        kind: ParticipantKind;
        hive_id: UUIDv7;
        colony_id: UUIDv7;
        owner_id?: UUIDv7;
        capabilities?: string[];
      } = {
        sub: participantId,
        iss: deps.hiveStableIdentifier,
        aud: deps.hiveStableIdentifier,
        iat,
        nbf: iat,
        exp,
        jti: newJti,
        kind,
        hive_id: hiveId,
        colony_id: colonyId,
      };
      if (participant.kind === 'agent') {
        payload.owner_id = participant.agent.ownerId;
        payload.capabilities = participant.agent.capabilities;
      }

      const snapshotJson: JsonText = jsonStringify(payload);
      validateJsonText(snapshotJson, { maxBytes: snapshotMaxBytes });

      const jwt = await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'EdDSA', kid: deps.signingKey.kid, typ: 'JWT' })
        .sign(deps.signingKey.privateKey);

      // Atomic: insert new credential + revoke old in a single transaction.
      await deps.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('credentials')
          .values({
            jti: newJti,
            participant_id: participantId,
            participant_kind: kind,
            kid: deps.signingKey.kid,
            issued_at: dateToIso(issuedAt),
            not_before: dateToIso(issuedAt),
            expires_at: dateToIso(expiresAt),
            snapshot: snapshotJson,
            issued_by: input.requestedBy ?? null,
            revoked_at: null,
          })
          .execute();

        await tx
          .insertInto('credential_revocations')
          .values({
            jti: input.currentJti,
            revoked_by: input.requestedBy ?? null,
            reason: input.reason ?? 'rotation',
            credential_expires_at: currentRow.expires_at,
          })
          .onConflict((oc) => oc.column('jti').doNothing())
          .execute();

        await tx
          .updateTable('credentials')
          .set({ revoked_at: dateToIso(issuedAt) })
          .where('jti', '=', input.currentJti)
          .execute();
      });

      // Mutate the in-memory Set after the TX commits.
      deps.blocklist.recordAdded(input.currentJti);

      return {
        jti: newJti,
        jwt,
        expiresAt,
        participantId,
        kid: deps.signingKey.kid,
      };
    },
  };
}
