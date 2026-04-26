// Visibility Engine — implements `canSend` and `canSee`.
//
// `canSend` invariant (product invariant 7 — "no deny can happen without
// leaving a record"): every deny path in `canSend` converges in the audit-write
// block before returning. There is NO early return that bypasses the log.
// Refactors that introduce an early-return for a deny path break this
// invariant — the integration tests (denial → audit row in DB) catch it.
//
// `canSee` audit policy (per tech spec — log policy decision):
//   - Default: deny is silent (high-frequency, low forensic value).
//   - Opt-in: `HIVE_VISIBILITY_AUDIT_CANSEE_DENIALS=true` audits each deny.
//   - canSee NEVER audits allows.

import type { IdentityContext } from '#domain/auth/types.js';
import type { Participant, ParticipantsReadRepo } from '#domain/auth/index.js';
import type { AuditRecorder } from '#domain/audit/recorder.js';
import type { NewAuditEvent } from '#domain/audit/types.js';

import { classifyRecipient, lookup, senderClass } from './matrix.js';
import type {
  DenialReason,
  RecipientClass,
  ResolvedRecipient,
  SenderClass,
  VisibilityEngine,
} from './types.js';

export interface EngineConfig {
  /**
   * If true, `canSee` denials emit an audit event. Default false (read from
   * `HIVE_VISIBILITY_AUDIT_CANSEE_DENIALS`).
   */
  auditCanSeeDenials?: boolean;
}

export interface EngineDeps {
  participantsRepo: ParticipantsReadRepo;
  recorder: AuditRecorder;
  /** Override clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

type Decision =
  | { kind: 'allow' }
  | {
      kind: 'deny';
      reason: DenialReason;
      senderClass: SenderClass;
      recipientClass: RecipientClass | null;
    };

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function resolveEngineConfig(config: EngineConfig = {}): Required<EngineConfig> {
  return {
    auditCanSeeDenials:
      config.auditCanSeeDenials ?? readBoolEnv('HIVE_VISIBILITY_AUDIT_CANSEE_DENIALS'),
  };
}

function participantToResolvedRecipient(participant: Participant): ResolvedRecipient {
  if (participant.kind === 'hivekeeper') {
    return {
      id: participant.hivekeeper.id,
      kind: 'hivekeeper',
      hiveId: participant.hivekeeper.hiveId,
    };
  }
  // Agent
  const r: ResolvedRecipient = {
    id: participant.agent.id,
    kind: participant.agent.type, // 'worker' | 'scout' — the LIVE type, per invariant 11
    type: participant.agent.type,
    hiveId: participant.agent.hiveId,
  };
  r.ownerId = participant.agent.ownerId;
  return r;
}

function buildDenialAuditEvent(
  caller: IdentityContext,
  recipientId: string,
  decision: Extract<Decision, { kind: 'deny' }>,
  occurredAt: Date,
  requestId: string | undefined,
): NewAuditEvent {
  return {
    category: 'visibility_denial',
    decision: 'deny',
    actorId: caller.participantId,
    actorKind: caller.kind,
    subjectId: recipientId,
    subjectKind: 'participant',
    reasonCode: decision.reason,
    detail: {
      senderClass: decision.senderClass,
      recipientClass: decision.recipientClass,
    },
    requestId: requestId ?? null,
    hiveId: caller.hiveId,
    occurredAt,
  };
}

export function createVisibilityEngine(
  deps: EngineDeps,
  config: EngineConfig = {},
): VisibilityEngine {
  const resolved = resolveEngineConfig(config);
  const now = deps.now ?? ((): Date => new Date());

  return {
    async canSend(input) {
      const occurredAt = now();
      const sender = senderClass(input.callerContext);

      // Step 1: resolve recipient.
      const participant = await deps.participantsRepo.findById(input.recipientId);

      // Step 2: derive decision (allow / deny with reason).
      let decision: Decision;
      if (participant === null) {
        decision = {
          kind: 'deny',
          reason: 'recipient_not_found',
          senderClass: sender,
          recipientClass: null,
        };
      } else {
        const resolvedRecipient = participantToResolvedRecipient(participant);
        if (resolvedRecipient.hiveId !== input.callerContext.hiveId) {
          // Defense-in-depth — auth already enforces single-Hive in v0.1.
          decision = {
            kind: 'deny',
            reason: 'cross_hive',
            senderClass: sender,
            recipientClass: null,
          };
        } else {
          const recipient = classifyRecipient(input.callerContext, resolvedRecipient);
          const row = lookup(sender, recipient);
          if (row.decision === 'allow') {
            decision = { kind: 'allow' };
          } else {
            decision = {
              kind: 'deny',
              reason: row.reason as DenialReason,
              senderClass: sender,
              recipientClass: recipient,
            };
          }
        }
      }

      // Step 3 (invariant): every deny converges here before returning.
      if (decision.kind === 'deny') {
        await deps.recorder.recordEvent(
          buildDenialAuditEvent(
            input.callerContext,
            input.recipientId,
            decision,
            occurredAt,
            input.requestId,
          ),
        );
        return false;
      }

      return true;
    },

    async canSee(input) {
      const occurredAt = now();
      const target = await deps.participantsRepo.findById(input.targetId);

      let allowed: boolean;
      if (target === null) {
        allowed = false;
      } else {
        const resolvedTarget = participantToResolvedRecipient(target);
        if (resolvedTarget.hiveId !== input.callerContext.hiveId) {
          allowed = false;
        } else {
          allowed = canSeeDecision(input.callerContext, resolvedTarget);
        }
      }

      // canSee audit is opt-in per the log policy decision in the tech spec.
      if (!allowed && resolved.auditCanSeeDenials) {
        await deps.recorder.recordEvent({
          category: 'visibility_denial',
          decision: 'deny',
          actorId: input.callerContext.participantId,
          actorKind: input.callerContext.kind,
          subjectId: input.targetId,
          subjectKind: 'participant',
          reasonCode: 'cansee_denied',
          detail: null,
          requestId: input.requestId ?? null,
          hiveId: input.callerContext.hiveId,
          occurredAt,
        });
      }
      return allowed;
    },
  };
}

/**
 * canSee derivation per tech spec — derived from product visibility principles.
 *
 *   - Hivekeeper visible to other Hivekeepers (and to self).
 *   - Scout visible to every participant of the Hive (public role).
 *   - Worker visible to its owner Hivekeeper, to agents of the same owner,
 *     and to itself.
 *   - Agents do NOT see Hivekeepers they don't own (sub-rule, tech spec).
 *
 * If product later rejects this derivation, this function changes; the
 * matrix and `canSend` are not affected.
 */
function canSeeDecision(caller: IdentityContext, target: ResolvedRecipient): boolean {
  if (caller.participantId === target.id) return true;

  if (target.kind === 'hivekeeper') {
    // Only Hivekeepers see other Hivekeepers in the directory (v0.1 inference).
    return caller.kind === 'hivekeeper';
  }

  // Target is an agent.
  if (target.type === 'scout') return true; // Public — visible to all in the Hive.

  // Target is a worker.
  const targetOwnerId = target.ownerId;
  if (targetOwnerId === undefined) return false; // Defense — should not happen for live agents.

  if (caller.kind === 'hivekeeper') {
    return caller.participantId === targetOwnerId;
  }
  // Caller is an agent — visible if they share the same owner Hivekeeper.
  return caller.ownerId === targetOwnerId;
}
