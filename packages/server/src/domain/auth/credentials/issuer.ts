// Issuer — emits Ed25519-signed JWTs and persists their metadata.
// Per the Auth + Identity tech spec:
//   - Pre-conditions enforced before signing:
//       1. participant exists in `hivekeepers` or `agents` (else
//          PARTICIPANT_NOT_FOUND_FOR_ISSUE).
//       2. participant.state === 'active' (else PARTICIPANT_NOT_ACTIVE{state}).
//          'suspended' Agents are explicitly NOT issuable, mirroring the verifier's
//          step 7 — issuing for a suspended participant would let them work around
//          the suspension by rotating their token.
//   - jti generated via uuid v7 (sortable, leak only the issuance ms — accepted in v0.1).
//   - The compact JWT itself is NEVER persisted; only metadata + the payload snapshot are
//     stored in `credentials.snapshot` (jsonb in PG, text in SQLite, validated <16 KB).
//   - TTL default in milliseconds is provided by the caller; the Hive default
//     (HIVE_AUTH_CREDENTIAL_DEFAULT_TTL_DAYS) is materialized at the composition root.

import * as jose from 'jose';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { Database, JsonText } from '#persistence/schema.js';
import { dateToIso, jsonStringify, validateJsonText } from '#persistence/type-mappers.js';
import { AuthError } from '../errors.js';
import type { SigningKey } from '../keys/keypair-store.js';
import type { ParticipantsReadRepo } from '../participants/repository.js';
import type { Logger } from '#observability/logger.js';

import type { Duration, IssuedCredential, ParticipantKind, UUIDv7 } from '../types.js';

export interface IssueCredentialInput {
  participantId: UUIDv7;
  // Time-to-live in milliseconds. Defaults to `defaultTtlMs` from deps.
  ttl?: Duration;
  notBefore?: Date;
  issuedBy?: UUIDv7;
  reason?: string;
}

export interface IssuerDeps {
  signingKey: SigningKey;
  participantsRepo: Pick<ParticipantsReadRepo, 'findById'>;
  hiveStableIdentifier: UUIDv7;
  // Default TTL in milliseconds when input.ttl is not provided.
  defaultTtlMs: Duration;
  // Maximum bytes for the snapshot payload. Default 16 KB per spec.
  snapshotMaxBytes?: number;
  db: Kysely<Database>;
  // Injectable clock for tests.
  now?: () => Date;
  logger?: Logger;
}

export interface Issuer {
  issueCredential(input: IssueCredentialInput): Promise<IssuedCredential>;
}

export function createIssuer(deps: IssuerDeps): Issuer {
  const snapshotMaxBytes = deps.snapshotMaxBytes ?? 16 * 1024;

  return {
    async issueCredential(input): Promise<IssuedCredential> {
      const participant = await deps.participantsRepo.findById(input.participantId);
      if (!participant) {
        throw new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
      }
      const state =
        participant.kind === 'hivekeeper' ? participant.hivekeeper.state : participant.agent.state;
      if (state !== 'active') {
        throw new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: state });
      }

      const now = deps.now ? deps.now() : new Date();
      const jti = uuidv7();
      const ttlMs = input.ttl ?? deps.defaultTtlMs;
      const notBefore = input.notBefore ?? now;
      const expiresAt = new Date(now.getTime() + ttlMs);
      const iat = Math.floor(now.getTime() / 1000);
      const nbf = Math.floor(notBefore.getTime() / 1000);
      const exp = Math.floor(expiresAt.getTime() / 1000);

      const kind: ParticipantKind =
        participant.kind === 'hivekeeper' ? 'hivekeeper' : participant.agent.type;
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
        sub: input.participantId,
        iss: deps.hiveStableIdentifier,
        aud: deps.hiveStableIdentifier,
        iat,
        nbf,
        exp,
        jti,
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

      await deps.db
        .insertInto('credentials')
        .values({
          jti,
          participant_id: input.participantId,
          participant_kind: kind,
          kid: deps.signingKey.kid,
          issued_at: dateToIso(now),
          not_before: dateToIso(notBefore),
          expires_at: dateToIso(expiresAt),
          snapshot: snapshotJson,
          issued_by: input.issuedBy ?? null,
          revoked_at: null,
        })
        .execute();

      if (deps.logger) {
        deps.logger.info(
          {
            event: 'auth_credential_issued',
            participantId: input.participantId,
            kind,
            jti,
            kid: deps.signingKey.kid,
            expiresAt: dateToIso(expiresAt),
          },
          'auth credential issued',
        );
      }

      return {
        jti,
        jwt,
        expiresAt,
        participantId: input.participantId,
        kid: deps.signingKey.kid,
      };
    },
  };
}
