// Enrollment retention job (ADR-026, Auth + Identity tech spec § `participants/retention.ts`).
//
// Three idempotent passes over Agents with `origin = 'enrollment'`:
//   1. retire: `active` Agents offline for longer than the retention become `retired`. A
//      live holder (open stream) is never retired. The UPDATE re-checks state, origin and
//      `last_connected_at`, so a claim or renewal that refreshes the row first wins.
//   2. grace: `retired` Agents past the grace become `revoked` through the revokeAgent
//      transition (Cell closed in the same transaction, name freed).
//   3. purge: Worker token rows that can no longer serve as holder proof are deleted.
// Retention or grace set to 0 disables its pass. The scheduler lives in the composition
// root; this module never imports Waggle (`isHolderLive` is injected).

import type { ExpressionBuilder, Kysely } from 'kysely';

import type { AuditRecorder } from '#domain/audit/index.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { requireAdminCaller } from '../caller-context.js';
import type { CallerContext } from '../caller-context.js';
import { purgeExpiredWorkerTokens } from '#domain/auth/credentials/worker-tokens.js';
import type { UUIDv7 } from '../types.js';

import { noopCellsHook } from './cells-hook.js';
import type { CellsRepoHook } from './cells-hook.js';
import type { ParticipantStateSignal } from './state-signal.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type EnrollmentRetentionPass = 'retire' | 'grace' | 'purge';

/** A pass failed; `pass` feeds the `auth_enrollment_retention_failed` log. */
export class EnrollmentRetentionPassError extends Error {
  override readonly name = 'EnrollmentRetentionPassError';
  constructor(
    readonly pass: EnrollmentRetentionPass,
    cause: unknown,
  ) {
    super(
      `enrollment retention pass '${pass}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export interface EnrollmentRetentionDeps {
  db: Kysely<Database>;
  // HIVE_ENROLLMENT_RETENTION_DAYS. 0 disables the retirement pass.
  retentionDays: number;
  // HIVE_ENROLLMENT_GRACE_DAYS. 0 keeps retired Agents indefinitely.
  graceDays: number;
  // HIVE_HOLDER_PROOF_WINDOW_DAYS: the cut of the Worker token row purge.
  holderProofWindowDays?: number;
  clockToleranceSeconds?: number;
  cellsHook?: CellsRepoHook;
  stateSignal?: ParticipantStateSignal;
  auditRecorder?: Pick<AuditRecorder, 'recordEvent'>;
}

export interface EnrollmentRetentionResult {
  retiredAgentIds: UUIDv7[];
  revokedAgentIds: UUIDv7[];
  purgedTokenRows: number;
}

export interface EnrollmentRetention {
  runEnrollmentRetention(
    now: Date,
    caller: CallerContext,
    deps: { isHolderLive: (agentId: UUIDv7) => boolean },
  ): Promise<EnrollmentRetentionResult>;
}

export function createEnrollmentRetention(deps: EnrollmentRetentionDeps): EnrollmentRetention {
  const { db } = deps;
  const cellsHook = deps.cellsHook ?? noopCellsHook;

  async function retire(now: Date, isHolderLive: (agentId: UUIDv7) => boolean): Promise<UUIDv7[]> {
    if (deps.retentionDays <= 0) return [];
    const threshold = dateToIso(new Date(now.getTime() - deps.retentionDays * DAY_MS));
    const candidates = await db
      .selectFrom('agents')
      .select('id')
      .where('state', '=', 'active')
      .where('origin', '=', 'enrollment')
      .where((eb) => offlineSince(eb, threshold))
      .execute();
    const ids = candidates.map((c) => c.id).filter((id) => !isHolderLive(id));
    if (ids.length === 0) return [];

    const retired = await db
      .updateTable('agents')
      .set({ state: 'retired', retired_at: dateToIso(now) })
      .where('id', 'in', ids)
      .where('state', '=', 'active')
      .where('origin', '=', 'enrollment')
      .where((eb) => offlineSince(eb, threshold))
      .returning(['id', 'hive_id', 'last_connected_at', 'created_at'])
      .execute();

    for (const row of retired) {
      deps.stateSignal?.emit({ participantId: row.id, newState: 'retired' });
      await deps.auditRecorder?.recordEvent({
        category: 'agent_retired',
        decision: 'success',
        actorId: null,
        actorKind: 'system',
        subjectId: row.id,
        subjectKind: 'participant',
        reasonCode: null,
        detail: {
          lastConnectedAt: toIso(row.last_connected_at),
          retentionDays: deps.retentionDays,
        },
        requestId: null,
        hiveId: row.hive_id,
        occurredAt: now,
      });
    }
    return retired.map((r) => r.id);
  }

  async function endGrace(now: Date): Promise<UUIDv7[]> {
    if (deps.graceDays <= 0) return [];
    const cutoff = dateToIso(new Date(now.getTime() - deps.graceDays * DAY_MS));
    const expired = await db
      .selectFrom('agents')
      .select(['id', 'retired_at'])
      .where('state', '=', 'retired')
      .where('retired_at', '<', cutoff)
      .execute();

    const revoked: UUIDv7[] = [];
    for (const { id, retired_at: retiredAt } of expired) {
      // Same transition as revokeAgent; conditional, so a revival that commits first wins.
      const row = await db.transaction().execute(async (tx) => {
        const moved = await tx
          .updateTable('agents')
          .set({ state: 'revoked', revoked_at: dateToIso(now), retired_at: null })
          .where('id', '=', id)
          .where('state', '=', 'retired')
          .where('retired_at', '<', cutoff)
          .returning('hive_id')
          .executeTakeFirst();
        if (moved) await cellsHook.closeCell(tx, { ownerId: id });
        return moved;
      });
      if (!row) continue;
      revoked.push(id);
      deps.stateSignal?.emit({ participantId: id, newState: 'revoked' });
      await deps.auditRecorder?.recordEvent({
        category: 'admin_agent_revoke',
        decision: 'success',
        actorId: null,
        actorKind: 'system',
        subjectId: id,
        subjectKind: 'participant',
        reasonCode: 'enrollment_grace_expired',
        detail: { retiredAt: toIso(retiredAt), graceDays: deps.graceDays },
        requestId: null,
        hiveId: row.hive_id,
        occurredAt: now,
      });
    }
    return revoked;
  }

  return {
    async runEnrollmentRetention(now, caller, { isHolderLive }) {
      requireAdminCaller(caller);
      const retiredAgentIds = await inPass('retire', () => retire(now, isHolderLive));
      const revokedAgentIds = await inPass('grace', () => endGrace(now));
      const purgedTokenRows = await inPass('purge', () =>
        purgeExpiredWorkerTokens(db, now, {
          ...(deps.holderProofWindowDays !== undefined && {
            holderProofWindowDays: deps.holderProofWindowDays,
          }),
          ...(deps.clockToleranceSeconds !== undefined && {
            clockToleranceSeconds: deps.clockToleranceSeconds,
          }),
        }),
      );
      return { retiredAgentIds, revokedAgentIds, purgedTokenRows };
    },
  };
}

// `last_connected_at` older than the threshold, or never connected and created before it.
function offlineSince(eb: ExpressionBuilder<Database, 'agents'>, threshold: string) {
  return eb.or([
    eb('last_connected_at', '<', threshold),
    eb.and([eb('last_connected_at', 'is', null), eb('created_at', '<', threshold)]),
  ]);
}

async function inPass<T>(pass: EnrollmentRetentionPass, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new EnrollmentRetentionPassError(pass, err);
  }
}

// SQLite stores ISO text, Postgres returns a Date for timestamptz.
function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}
