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
//
// The registration primitives (create, claim) are authorized by scope and ownership, not
// by the admin flag: the owner of the enrollment is the owner of the Agent.

import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { DbDialect } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { requireAdminCaller } from '../caller-context.js';
import type { CallerContext } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { Agent } from '#domain/auth/participants/entities.js';
import { noopCellsHook } from '#domain/auth/participants/cells-hook.js';
import type { CellsRepoHook } from '#domain/auth/participants/cells-hook.js';
import type { Duration, IdentityContext, IssuedCredential, UUIDv7 } from '../types.js';

import { mintCredential } from './issuer.js';
import type { IssuerDeps, MintDeps } from './issuer.js';
import {
  DEFAULT_CLOCK_TOLERANCE_SECONDS,
  DEFAULT_HOLDER_PROOF_WINDOW_DAYS,
  blocklistWorkerTokens,
  holderProofCutoff,
} from './worker-tokens.js';

// Agent name slug of ADR-015. A name prefix must itself be a valid start of a name.
const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_MAX_LENGTH = 280;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const DEFAULT_WORKER_TOKEN_TTL_MS = 3600 * 1000;

export interface EnrollmentDeps extends MintDeps {
  participantsRepo: IssuerDeps['participantsRepo'];
  // HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS, materialized in milliseconds by the caller.
  enrollmentTtlMs: Duration;
  // HIVE_ENROLLMENT_MAX_AGENTS: the Hive-wide ceiling of the `max_agents` claim, and the
  // quota of an enrollment without the claim.
  hiveMaxAgents: number;
  // HIVE_WORKER_TOKEN_TTL_SECONDS, materialized in milliseconds by the caller.
  workerTokenTtlMs?: Duration;
  // HIVE_HOLDER_PROOF_WINDOW_DAYS. Default 7.
  holderProofWindowDays?: number;
  // Same default as the verifier and the blocklist.
  clockToleranceSeconds?: number;
  // Postgres serializes the registrations of one enrollment with an advisory lock;
  // SQLite already serializes writers. Default 'sqlite'.
  dialect?: DbDialect;
  // Cross-domain hook into Cell Store: the Cell of a created Agent.
  cellsHook?: CellsRepoHook;
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
  // Recorded as `issued_by` for the system caller (the `hivectl --operator-id`); an
  // authenticated caller is always recorded as itself.
  issuedBy?: UUIDv7;
}

export interface CreateEnrolledAgentInput {
  ownerId: UUIDv7;
  name: string;
  description: string;
  capabilities?: string[];
  enrolledVia: UUIDv7;
}

export interface ClaimEnrolledAgentInput {
  agentId: UUIDv7;
  description: string;
  capabilities?: string[];
  enrolledVia: UUIDv7;
}

export interface RevokeWorkerTokensInput {
  agentId: UUIDv7;
  revokedBy: UUIDv7;
  reason: string;
}

export interface RegisteredAgent {
  agent: Agent;
  token: IssuedCredential;
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
  /**
   * New `origin = 'enrollment'` Worker, its Cell and its first Worker token in one
   * transaction, with the quota checked in that same transaction. The loser of two
   * concurrent creates with the same name gets NAME_IN_USE.
   */
  createEnrolledAgent(
    input: CreateEnrolledAgentInput,
    identity: IdentityContext,
  ): Promise<RegisteredAgent>;
  /** Re-binds an `active` enrollment Agent to the claiming enrollment; same id and Cell. */
  claimEnrolledAgent(
    input: ClaimEnrolledAgentInput,
    identity: IdentityContext,
  ): Promise<RegisteredAgent>;
  /** Blocklists every Worker token of the Agent in the window (`hivectl agent release`). */
  revokeWorkerTokens(
    input: RevokeWorkerTokensInput,
    caller: CallerContext,
  ): Promise<{ revokedTokenJtis: UUIDv7[] }>;
}

export function createEnrollment(deps: EnrollmentDeps): Enrollment {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const cutoff = (at: Date): Date =>
    holderProofCutoff(
      at,
      deps.holderProofWindowDays ?? DEFAULT_HOLDER_PROOF_WINDOW_DAYS,
      deps.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
    );
  const cellsHook = deps.cellsHook ?? noopCellsHook;

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
      await blocklistWorkerTokens(trx, {
        selector: { agentId: input.agentId },
        expiresAfter: cutoff(at),
        reason: 'superseded',
        revokedBy: null,
      });
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

  function issueWorkerToken(
    input: IssueWorkerTokenInput,
    executor?: Transaction<Database>,
  ): Promise<IssuedCredential> {
    if (executor) return issueInTransaction(executor, input);
    return deps.db.transaction().execute((trx) => issueInTransaction(trx, input));
  }

  async function lockEnrollment(trx: Transaction<Database>, enrolledVia: UUIDv7): Promise<void> {
    if (deps.dialect === 'postgres') {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`enroll:${enrolledVia}`}, 0))`.execute(
        trx,
      );
    }
  }

  async function loadAgent(trx: Transaction<Database>, agentId: UUIDv7): Promise<Agent> {
    const participant = await deps.participantsRepo.findById(agentId, trx);
    if (!participant || participant.kind !== 'agent') {
      throw new Error(`DB anomaly: Agent ${agentId} missing inside its own transaction`);
    }
    return participant.agent;
  }

  return {
    issueWorkerToken,

    async issueEnrollmentCredential(input, caller): Promise<IssuedCredential> {
      const issuedBy = authorizeIssue(input.ownerId, caller) ?? input.issuedBy ?? null;
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

    async createEnrolledAgent(input, identity): Promise<RegisteredAgent> {
      assertEnrollmentOwner(identity, input.ownerId, input.enrolledVia);
      if (!AGENT_NAME_RE.test(input.name)) {
        throw new AuthError('INVALID_INPUT', { subCode: 'name_malformed' });
      }
      const prefix = identity.snapshot.namePrefix;
      if (prefix !== undefined && !input.name.startsWith(prefix)) {
        throw new AuthError('INVALID_INPUT', { subCode: 'name_prefix_mismatch' });
      }
      validateDescription(input.description);
      const limit = identity.snapshot.maxAgents ?? deps.hiveMaxAgents;

      return deps.db.transaction().execute(async (trx) => {
        await lockEnrollment(trx, input.enrolledVia);
        const active = await trx
          .selectFrom('agents')
          .select((eb) => eb.fn.countAll<string | number | bigint>().as('n'))
          .where('enrolled_via', '=', input.enrolledVia)
          .where('state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(active.n) >= limit) {
          throw new AuthError('ENROLLMENT_QUOTA_EXCEEDED', { limit });
        }

        const id = uuidv7();
        try {
          await trx
            .insertInto('agents')
            .values({
              id,
              hive_id: identity.hiveId,
              colony_id: identity.colonyId,
              owner_id: input.ownerId,
              name: input.name,
              type: 'worker',
              capabilities: jsonStringify(input.capabilities ?? []),
              instructions: '',
              state: 'active',
              revoked_at: null,
              last_connected_at: dateToIso(now()),
              origin: 'enrollment',
              enrolled_via: input.enrolledVia,
              description: input.description,
            })
            .execute();
        } catch (err) {
          if (err instanceof Error && /UNIQUE/i.test(err.message)) {
            throw new AuthError('NAME_IN_USE', { cause: err });
          }
          throw err;
        }
        await cellsHook.createCell(trx, {
          ownerId: id,
          ownerKind: 'agent',
          hiveId: identity.hiveId,
          colonyId: identity.colonyId,
        });

        const token = await issueWorkerToken(
          { agentId: id, mode: 'create', enrolledVia: input.enrolledVia },
          trx,
        );
        return { agent: await loadAgent(trx, id), token };
      });
    },

    async claimEnrolledAgent(input, identity): Promise<RegisteredAgent> {
      validateDescription(input.description);

      return deps.db.transaction().execute(async (trx) => {
        await lockEnrollment(trx, input.enrolledVia);
        const current = await loadAgentOrNull(trx, input.agentId);
        if (!current || current.state !== 'active' || current.origin !== 'enrollment') {
          throw new AuthError('INVALID_STATE_TRANSITION', {
            subCode: 'claim_requires_active_enrollment_agent',
          });
        }
        assertEnrollmentOwner(identity, current.ownerId, input.enrolledVia);

        await trx
          .updateTable('agents')
          .set({
            description: input.description,
            capabilities: jsonStringify(input.capabilities ?? current.capabilities),
            last_connected_at: dateToIso(now()),
            enrolled_via: input.enrolledVia,
          })
          .where('id', '=', input.agentId)
          .execute();

        const token = await issueWorkerToken(
          { agentId: input.agentId, mode: 'claim', enrolledVia: input.enrolledVia },
          trx,
        );
        return { agent: await loadAgent(trx, input.agentId), token };
      });

      async function loadAgentOrNull(
        trx: Transaction<Database>,
        agentId: UUIDv7,
      ): Promise<Agent | null> {
        const participant = await deps.participantsRepo.findById(agentId, trx);
        return participant?.kind === 'agent' ? participant.agent : null;
      }
    },

    async revokeWorkerTokens(input, caller): Promise<{ revokedTokenJtis: UUIDv7[] }> {
      return deps.db.transaction().execute(async (trx) => {
        const agent = await trx
          .selectFrom('agents')
          .select('owner_id')
          .where('id', '=', input.agentId)
          .executeTakeFirst();
        if (!agent) {
          throw new AuthError('INVALID_STATE_TRANSITION', { subCode: 'agent_not_found' });
        }
        if (caller.kind === 'authenticated' && caller.identity.participantId !== agent.owner_id) {
          requireAdminCaller(caller);
        }

        const revokedTokenJtis = await blocklistWorkerTokens(trx, {
          selector: { agentId: input.agentId },
          expiresAfter: cutoff(now()),
          reason: input.reason,
          revokedBy: input.revokedBy,
        });
        await trx
          .updateTable('agents')
          .set({ last_worker_jti: null })
          .where('id', '=', input.agentId)
          .execute();
        return { revokedTokenJtis };
      });
    },
  };
}

// The registration primitives run with the enrollment Bearer's identity: an enrollment
// credential whose owner is the Agent's owner and whose jti is the `enrolledVia` given.
function assertEnrollmentOwner(
  identity: IdentityContext,
  ownerId: UUIDv7,
  enrolledVia: UUIDv7,
): void {
  if (
    identity.snapshot.scope !== 'enroll' ||
    identity.participantId !== ownerId ||
    identity.snapshot.credentialJti !== enrolledVia
  ) {
    throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode: 'not_enrollment_owner' });
  }
}

function validateDescription(description: string): void {
  if (
    description.trim().length === 0 ||
    description.length > DESCRIPTION_MAX_LENGTH ||
    CONTROL_CHARS_RE.test(description)
  ) {
    throw new AuthError('INVALID_INPUT', { subCode: 'description_invalid' });
  }
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
