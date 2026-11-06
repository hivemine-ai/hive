// Tool 9 — register_session (ADR-026). The only place that composes Auth and the
// Presence Registry for a session enrollment: Auth never imports Waggle.
//
// - Renewal (the Bearer is the last Worker token, verified by verifyRenewalBearer):
//   renewWorkerToken (CAS on the last token, no reservation: the holder never collides
//   with itself), then the open streams of the Agent move to the new token.
// - Registration (the Bearer is the enrollment credential): name and description are
//   validated, then the Agent of the owner with that name decides the path. None →
//   createEnrolledAgent (the unique index serializes concurrent creates). Manual or
//   Scout → NAME_TAKEN. Suspended → AGENT_SUSPENDED. Live holder → NAME_IN_USE.
//   Offline → claimHolder, then claimEnrolledAgent; a failed transaction releases the
//   reservation.
//
// Domain rejections of a registration feed a per-process counter per (owner, name): at
// the threshold the owner gets one audit event and one notice in its Cell. A created
// Agent is announced to the owner the same way. A failed notice never fails the call.
//
// The outcome stays internal (logs); the wire carries only the new token.

import { z } from 'zod';

import { AuthError, validateDescription, validateEnrollmentName } from '#domain/auth/index.js';
import type {
  Agent,
  Enrollment,
  IdentityContext,
  IssuedCredential,
  ParticipantsReadRepo,
  UUIDv7,
} from '#domain/auth/index.js';
import type { AuditRecorder } from '#domain/audit/index.js';
import type { Sender } from '#domain/cells/index.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import type { Logger } from '#observability/logger.js';

import type { RejectAlertCounter } from '../enrollment-guards.js';
import type { RequestContext } from '../types.js';

const DESCRIPTION_MAX_LENGTH = 280;

export const RegisterSessionInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(DESCRIPTION_MAX_LENGTH),
  capabilities: z.array(z.string()).optional(),
});
export type RegisterSessionInput = z.infer<typeof RegisterSessionInputSchema>;

export interface RegisterSessionOutput {
  agent_ref: string;
  agent_id: string;
  token: string;
  expires_at: string;
}

export type RegisterSessionOutcome = 'created' | 'claimed' | 'renewed';

export interface RegisterSessionResult {
  outcome: RegisterSessionOutcome;
  output: RegisterSessionOutput;
}

export interface RegisterSessionDeps {
  enrollment: Pick<Enrollment, 'createEnrolledAgent' | 'claimEnrolledAgent' | 'renewWorkerToken'>;
  participantsRepo: Pick<
    ParticipantsReadRepo,
    'findAgentByName' | 'findAgentById' | 'findHivekeeperById'
  >;
  presenceRegistry: Pick<PresenceRegistry, 'isHolderLive' | 'claimHolder' | 'releaseClaim'>;
  /** `listen-stream.ts`: moves the open streams of the Agent to the renewed token. */
  rebindParticipantStreams: (
    participantId: UUIDv7,
    credential: { jti: UUIDv7; expiresAt: Date },
  ) => number;
  rejectAlerts: RejectAlertCounter;
  /** HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES, for the text and the audit detail. */
  rejectAlertWindowMinutes: number;
  sender: Pick<Sender, 'depositSystemNotification'>;
  auditRecorder: Pick<AuditRecorder, 'recordEvent'>;
  logger: Pick<Logger, 'info' | 'warn'>;
}

const COUNTED_REJECTIONS: ReadonlySet<string> = new Set([
  'NAME_IN_USE',
  'NAME_TAKEN',
  'AGENT_SUSPENDED',
  'ENROLLMENT_QUOTA_EXCEEDED',
]);

/** What the registration learned about an existing Agent before it failed or claimed. */
interface Seen {
  agentId: UUIDv7 | null;
  previousEnrolledVia: UUIDv7 | null;
}

function isCountedRejection(err: unknown): boolean {
  if (!(err instanceof AuthError)) return false;
  return (
    COUNTED_REJECTIONS.has(err.code) ||
    (err.code === 'INVALID_INPUT' && err.subCode === 'name_prefix_mismatch')
  );
}

export function createRegisterSessionHandler(deps: RegisterSessionDeps) {
  async function agentRef(agent: Agent, identity: IdentityContext): Promise<string> {
    const owner = await deps.participantsRepo.findHivekeeperById(agent.ownerId);
    if (!owner) throw new Error(`DB anomaly: owner ${agent.ownerId} of Agent ${agent.id} missing`);
    const ownerLocal = owner.email.slice(0, owner.email.indexOf('@')).toLowerCase();
    return `${agent.name}@${ownerLocal}.${identity.hiveName}`;
  }

  async function respond(
    outcome: RegisterSessionOutcome,
    agent: Agent,
    token: IssuedCredential,
    identity: IdentityContext,
  ): Promise<RegisterSessionResult> {
    return {
      outcome,
      output: {
        agent_ref: await agentRef(agent, identity),
        agent_id: agent.id,
        token: token.jwt,
        expires_at: token.expiresAt.toISOString(),
      },
    };
  }

  async function renew(input: RegisterSessionInput, ctx: RequestContext) {
    const { identity } = ctx;
    const agent = await deps.participantsRepo.findAgentById(identity.participantId);
    if (!agent) throw new AuthError('PARTICIPANT_NOT_FOUND');
    if (input.name !== agent.name) {
      throw new AuthError('INVALID_INPUT', { subCode: 'renewal_name_mismatch' });
    }
    validateDescription(input.description);

    const token = await deps.enrollment.renewWorkerToken({
      agentId: agent.id,
      presentedJti: identity.snapshot.credentialJti,
      description: input.description,
      ...(input.capabilities !== undefined && { capabilities: input.capabilities }),
    });
    deps.rebindParticipantStreams(agent.id, { jti: token.jti, expiresAt: token.expiresAt });
    return respond('renewed', agent, token, identity);
  }

  async function notifyOwner(
    kind: 'agent_enrolled' | 'enrollment_reject_alert',
    ownerId: UUIDv7,
    body: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.sender.depositSystemNotification(
        { recipientId: ownerId, body, action },
        { kind: 'system' },
      );
    } catch {
      deps.logger.warn({ event: 'mcp_enrollment_notify_failed', kind }, 'owner notice failed');
    }
  }

  async function onRejected(
    input: RegisterSessionInput,
    ctx: RequestContext,
    agentId: UUIDv7 | null,
  ): Promise<void> {
    const { identity } = ctx;
    const verdict = deps.rejectAlerts.record(identity.participantId, input.name);
    if (!verdict.alert) return;
    const enrolledVia = identity.snapshot.credentialJti;
    const windowMinutes = deps.rejectAlertWindowMinutes;
    await deps.auditRecorder.recordEvent({
      category: 'enrollment_reject_alert',
      decision: 'deny',
      actorId: identity.participantId,
      actorKind: 'hivekeeper',
      subjectId: agentId,
      subjectKind: agentId !== null ? 'participant' : null,
      reasonCode: null,
      detail: {
        name: input.name,
        rejections: verdict.rejections,
        windowMinutes,
        enrolledVia,
        viaEnrollmentJti: enrolledVia,
      },
      requestId: ctx.requestId,
      hiveId: identity.hiveId,
      occurredAt: new Date(),
    });
    await notifyOwner(
      'enrollment_reject_alert',
      identity.participantId,
      `Hive: ${String(verdict.rejections)} rejected session registrations for name '${input.name}' in ${String(windowMinutes)} min. If this was not you, revoke the enrollment credential.`,
      { kind: 'enrollment_reject_alert', name: input.name, enrolledVia },
    );
  }

  // Actor is the owner, operating through its enrollment credential (decision 9.14).
  async function auditRegistration(
    ctx: RequestContext,
    category: 'agent_enrolled' | 'agent_claimed',
    agentId: UUIDv7,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const { identity } = ctx;
    await deps.auditRecorder.recordEvent({
      category,
      decision: 'success',
      actorId: identity.participantId,
      actorKind: 'hivekeeper',
      subjectId: agentId,
      subjectKind: 'participant',
      reasonCode: null,
      detail: { ...detail, viaEnrollmentJti: identity.snapshot.credentialJti },
      requestId: ctx.requestId,
      hiveId: identity.hiveId,
      occurredAt: new Date(),
    });
  }

  async function register(input: RegisterSessionInput, ctx: RequestContext) {
    const seen: Seen = { agentId: null, previousEnrolledVia: null };
    let result: RegisterSessionResult;
    try {
      result = await registerOrReject(input, ctx, seen);
    } catch (err) {
      if (isCountedRejection(err)) await onRejected(input, ctx, seen.agentId);
      throw err;
    }

    const enrolledVia = ctx.identity.snapshot.credentialJti;
    const agentRef = result.output.agent_ref;
    if (result.outcome === 'created') {
      await auditRegistration(ctx, 'agent_enrolled', result.output.agent_id, {
        agentRef,
        enrolledVia,
      });
      await notifyOwner(
        'agent_enrolled',
        ctx.identity.participantId,
        `Hive: new session agent ${agentRef} registered via enrollment credential ${enrolledVia}.`,
        { kind: 'agent_enrolled', agentRef, enrolledVia },
      );
    } else {
      await auditRegistration(ctx, 'agent_claimed', result.output.agent_id, {
        enrolledVia,
        previousEnrolledVia: seen.previousEnrolledVia,
      });
    }
    return result;
  }

  async function registerOrReject(
    input: RegisterSessionInput,
    ctx: RequestContext,
    seen: Seen,
  ): Promise<RegisterSessionResult> {
    const { identity, requestId } = ctx;
    const enrolledVia = identity.snapshot.credentialJti;
    validateEnrollmentName(input.name, identity.snapshot.namePrefix);
    validateDescription(input.description);
    const capabilities = input.capabilities !== undefined && { capabilities: input.capabilities };

    const existing = await deps.participantsRepo.findAgentByName(
      identity.hiveId,
      identity.participantId,
      input.name,
    );
    if (!existing) {
      const created = await deps.enrollment.createEnrolledAgent(
        {
          ownerId: identity.participantId,
          name: input.name,
          description: input.description,
          ...capabilities,
          enrolledVia,
        },
        identity,
      );
      return respond('created', created.agent, created.token, identity);
    }

    seen.agentId = existing.id;
    seen.previousEnrolledVia = existing.enrolledVia;
    if (existing.origin === 'manual' || existing.type === 'scout') {
      throw new AuthError('NAME_TAKEN');
    }
    if (existing.state === 'suspended') throw new AuthError('AGENT_SUSPENDED');
    if (deps.presenceRegistry.isHolderLive(existing.id)) throw new AuthError('NAME_IN_USE');
    if (deps.presenceRegistry.claimHolder(existing.id, requestId).outcome === 'in_use') {
      throw new AuthError('NAME_IN_USE');
    }

    let claimed: Awaited<ReturnType<RegisterSessionDeps['enrollment']['claimEnrolledAgent']>>;
    try {
      claimed = await deps.enrollment.claimEnrolledAgent(
        { agentId: existing.id, description: input.description, ...capabilities, enrolledVia },
        identity,
      );
    } catch (err) {
      deps.presenceRegistry.releaseClaim(existing.id, requestId);
      throw err;
    }
    return respond('claimed', claimed.agent, claimed.token, identity);
  }

  return async function registerSession(
    input: RegisterSessionInput,
    ctx: RequestContext,
  ): Promise<RegisterSessionResult> {
    const { snapshot } = ctx.identity;
    if (snapshot.renewal === true) return renew(input, ctx);
    if (snapshot.scope === 'enroll') return register(input, ctx);
    // The binding sends nothing else here; defense in depth.
    throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode: 'not_enrollment_owner' });
  };
}
