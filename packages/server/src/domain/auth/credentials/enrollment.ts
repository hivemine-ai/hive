// Enrollment — the auth side of session enrollment (ADR-026, Auth + Identity tech spec
// § `credentials/enrollment.ts`).
//
// An enrollment credential is a JWT of the same issuer whose `sub` is the owner
// Hivekeeper and that carries `scope: "enroll"` plus the optional `name_prefix` and
// `max_agents` claims. It holds no admin or Hivekeeper authority: the verifier exposes the
// scope and never populates `isAdmin`, and the transport binding only lets it call
// `register_session`.
//
// A Worker token is a full credential of the Agent with a short TTL and the enrollment
// `jti` in `credentials.enrolled_via`. Its holder renews it by presenting the last token
// issued (`agents.last_worker_jti`), even expired, within the holder-proof window.

import { sql } from 'kysely';
import type { Transaction } from 'kysely';

import type { Database } from '#persistence/schema.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { requireAdminCaller } from '../caller-context.js';
import type { CallerContext } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { Duration, IssuedCredential, UUIDv7 } from '../types.js';

import { mintCredential } from './issuer.js';
import type { IssuerDeps, MintDeps } from './issuer.js';

// Agent name slug of ADR-015. A name prefix must itself be a valid start of a name.
const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface EnrollmentDeps extends MintDeps {
  participantsRepo: IssuerDeps['participantsRepo'];
  // HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS, materialized in milliseconds by the caller.
  enrollmentTtlMs: Duration;
  // HIVE_ENROLLMENT_MAX_AGENTS: the Hive-wide ceiling of the `max_agents` claim.
  hiveMaxAgents: number;
  // HIVE_WORKER_TOKEN_TTL_SECONDS, materialized in milliseconds by the caller.
  workerTokenTtlMs?: Duration;
  // HIVE_HOLDER_PROOF_WINDOW_DAYS. Default 7.
  holderProofWindowDays?: number;
  // Same default as the verifier and the blocklist.
  clockToleranceSeconds?: number;
}

export type WorkerTokenMode = 'create' | 'claim' | 'revive' | 'renew';

export interface IssueWorkerTokenInput {
  agentId: UUIDv7;
  mode: WorkerTokenMode;
  // Required for create / claim / revive: the `jti` of the enrollment Bearer.
  enrolledVia?: UUIDv7;
  // Required for renew: the `jti` of the token presented as holder proof.
  presentedJti?: UUIDv7;
  ttl?: Duration;
}

export interface IssueEnrollmentCredentialInput {
  ownerId: UUIDv7;
  namePrefix?: string;
  maxAgents?: number;
  ttl?: Duration;
}

export interface Enrollment {
  issueEnrollmentCredential(
    input: IssueEnrollmentCredentialInput,
    caller: CallerContext,
  ): Promise<IssuedCredential>;
  /**
   * One transaction per call; joins `executor` when the caller (a registration primitive)
   * already holds one. create / claim / revive supersede every token of the Agent still
   * inside the holder-proof window; renew supersedes nothing and moves
   * `agents.last_worker_jti` by compare-and-swap, so of two renewals with the same proof
   * exactly one wins.
   */
  issueWorkerToken(
    input: IssueWorkerTokenInput,
    executor?: Transaction<Database>,
  ): Promise<IssuedCredential>;
}

const DEFAULT_WORKER_TOKEN_TTL_MS = 3600 * 1000;
const DEFAULT_HOLDER_PROOF_WINDOW_DAYS = 7;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createEnrollment(deps: EnrollmentDeps): Enrollment {
  const windowMs =
    (deps.holderProofWindowDays ?? DEFAULT_HOLDER_PROOF_WINDOW_DAYS) * DAY_MS +
    (deps.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS) * 1000;
  const now = (): Date => (deps.now ? deps.now() : new Date());

  async function issueInTransaction(
    trx: Transaction<Database>,
    input: IssueWorkerTokenInput,
  ): Promise<IssuedCredential> {
    const at = now();
    let enrolledVia: UUIDv7;
    if (input.mode === 'renew') {
      if (input.presentedJti === undefined) {
        throw new Error('issueWorkerToken: presentedJti is required in renew mode');
      }
      const agent = await trx
        .selectFrom('agents')
        .select('enrolled_via')
        .where('id', '=', input.agentId)
        .executeTakeFirst();
      if (!agent?.enrolled_via) {
        throw new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_invalid' });
      }
      enrolledVia = agent.enrolled_via;
      await assertEnrollmentUsable(trx, enrolledVia, 'renew');
    } else {
      if (input.enrolledVia === undefined) {
        throw new Error(`issueWorkerToken: enrolledVia is required in ${input.mode} mode`);
      }
      enrolledVia = input.enrolledVia;
      await supersedeWorkerTokens(trx, input.agentId, new Date(at.getTime() - windowMs));
    }

    const participant = await deps.participantsRepo.findById(input.agentId, trx);
    if (!participant || participant.kind !== 'agent') {
      throw new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
    }
    const token = await mintCredential(
      deps,
      {
        participant,
        ttlMs: input.ttl ?? deps.workerTokenTtlMs ?? DEFAULT_WORKER_TOKEN_TTL_MS,
        issuedBy: null,
        enrolledVia,
      },
      trx,
    );

    if (input.mode === 'renew') {
      const swapped = await trx
        .updateTable('agents')
        .set({ last_worker_jti: token.jti, last_connected_at: dateToIso(at) })
        .where('id', '=', input.agentId)
        .where('last_worker_jti', '=', input.presentedJti as UUIDv7)
        .executeTakeFirst();
      if (Number(swapped.numUpdatedRows) === 0) {
        throw new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_superseded' });
      }
    } else {
      await trx
        .updateTable('agents')
        .set({ last_worker_jti: token.jti })
        .where('id', '=', input.agentId)
        .execute();
    }

    // Closes the race with a concurrent revocation of the enrollment, whose cascade only
    // sees child tokens already inserted.
    await assertEnrollmentUsable(trx, enrolledVia, input.mode);
    return token;
  }

  return {
    issueWorkerToken(input, executor): Promise<IssuedCredential> {
      if (executor) return issueInTransaction(executor, input);
      return deps.db.transaction().execute((trx) => issueInTransaction(trx, input));
    },

    async issueEnrollmentCredential(input, caller): Promise<IssuedCredential> {
      const issuedBy = authorizeIssue(input.ownerId, caller);
      validateClaims(input, deps.hiveMaxAgents);

      const owner = await deps.participantsRepo.findById(input.ownerId);
      if (!owner || owner.kind !== 'hivekeeper') {
        throw new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
      }
      if (owner.hivekeeper.state !== 'active') {
        throw new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: owner.hivekeeper.state });
      }

      return mintCredential(deps, {
        participant: owner,
        ttlMs: input.ttl ?? deps.enrollmentTtlMs,
        issuedBy,
        enrollment: {
          ...(input.namePrefix !== undefined ? { namePrefix: input.namePrefix } : {}),
          ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
        },
      });
    },
  };
}

// A Hivekeeper issues only for itself; another owner needs an admin (or the system
// caller). Returns the `issued_by` of the row.
function authorizeIssue(ownerId: UUIDv7, caller: CallerContext): UUIDv7 | null {
  if (caller.kind === 'system') return null;
  const { identity } = caller;
  if (identity.snapshot.scope !== undefined) {
    throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode: 'scoped_credential' });
  }
  if (identity.kind !== 'hivekeeper' || identity.participantId !== ownerId) {
    requireAdminCaller(caller);
  }
  return identity.participantId;
}

function validateClaims(input: IssueEnrollmentCredentialInput, hiveMaxAgents: number): void {
  if (input.namePrefix !== undefined && !AGENT_NAME_RE.test(input.namePrefix)) {
    throw new AuthError('INVALID_INPUT', { subCode: 'name_prefix_invalid' });
  }
  if (input.maxAgents !== undefined) {
    if (!Number.isInteger(input.maxAgents) || input.maxAgents < 1) {
      throw new AuthError('INVALID_INPUT', { subCode: 'max_agents_invalid' });
    }
    if (input.maxAgents > hiveMaxAgents) {
      throw new AuthError('INVALID_INPUT', { subCode: 'max_agents_exceeds_hive_limit' });
    }
  }
}

// A rotated enrollment (reason 'rotation') still lets its child tokens renew; it no longer
// registers. A revoked one does neither.
async function assertEnrollmentUsable(
  trx: Transaction<Database>,
  enrollmentJti: UUIDv7,
  mode: WorkerTokenMode,
): Promise<void> {
  const row = await trx
    .selectFrom('credential_revocations')
    .select('reason')
    .where('jti', '=', enrollmentJti)
    .executeTakeFirst();
  if (row === undefined) return;
  if (mode === 'renew' && row.reason === 'rotation') return;
  throw new AuthError('CREDENTIAL_REVOKED');
}

async function supersedeWorkerTokens(
  trx: Transaction<Database>,
  agentId: UUIDv7,
  expiresAfter: Date,
): Promise<void> {
  await trx
    .insertInto('credential_revocations')
    .columns(['jti', 'revoked_by', 'reason', 'credential_expires_at'])
    .expression((eb) =>
      eb
        .selectFrom('credentials')
        .select([
          'jti',
          sql<null>`NULL`.as('revoked_by'),
          sql<string>`'superseded'`.as('reason'),
          'expires_at',
        ])
        .where('participant_id', '=', agentId)
        .where('enrolled_via', 'is not', null)
        .where('expires_at', '>', dateToIso(expiresAfter)),
    )
    .onConflict((oc) => oc.column('jti').doNothing())
    .execute();
}
