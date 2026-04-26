// Audit Log write-side API. Hot path for the Visibility Engine (denials) and
// for admin operations across the system.
//
// Failure-mode contract (per the tech spec — non-transactional audit log):
//   - The recorder is fire-and-forget from the caller's perspective.
//   - On INSERT failure (DB outage, lock timeout, CHECK violation, dropped
//     connection): write a structured stderr entry + increment a metrics
//     counter, then return successfully. NEVER propagate to the caller.
//   - The originating operation (denial decision, admin op) keeps its outcome.
//
// Detail size policy (per the tech spec — detail size cap):
//   - App-side cap from `HIVE_AUDIT_DETAIL_MAX_BYTES` (default 4096), clamped
//     to <= 4096 (the schema CHECK is the hard ceiling — operator can lower
//     the cap but cannot exceed it without ALTER TABLE).
//   - On overflow: drop the `detail` field (set to null) + log warning + still
//     persist the row. Better to record the event without detail than lose it.

import { v7 as uuidv7 } from 'uuid';
import type { Logger } from '#observability/logger.js';

import type { AuditRepo, InsertAuditEventInput } from './repository.js';
import type { AuditEventCategory, NewAuditEvent } from './types.js';

const SCHEMA_DETAIL_HARD_CEILING_BYTES = 4096;

/**
 * Module-level counter for `audit_log_record_failures_total{category}`.
 * Stub — replaced when a metrics library lands (Prometheus client TBD as
 * cross-spec decision). Tests read via `getAuditRecordFailureCount`.
 *
 * TODO(metrics-lib): swap for the real counter once the metrics lib is wired.
 */
const failureCounters: Map<AuditEventCategory, number> = new Map();

function incrementFailureCounter(category: AuditEventCategory): void {
  failureCounters.set(category, (failureCounters.get(category) ?? 0) + 1);
}

/**
 * Test/operator helper — read the current failure count for a category. The
 * counter is process-local; do not rely on it for production observability.
 */
export function getAuditRecordFailureCount(category: AuditEventCategory): number {
  return failureCounters.get(category) ?? 0;
}

/** Reset failure counters — used by tests to isolate cases. */
export function resetAuditRecordFailureCounters(): void {
  failureCounters.clear();
}

export interface RecorderConfig {
  /**
   * App-side cap on serialized `detail` size in bytes. Defaults to the env var
   * `HIVE_AUDIT_DETAIL_MAX_BYTES` (or 4096). Clamped to <= 4096 (schema cap).
   */
  detailMaxBytes?: number;
}

export interface RecorderDeps {
  auditRepo: AuditRepo;
  logger: Logger;
  /** Override clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override id generator for tests. Defaults to `uuidv7`. */
  idGen?: () => string;
}

export interface AuditRecorder {
  recordEvent(event: NewAuditEvent): Promise<void>;
  recordEventBatch(events: NewAuditEvent[]): Promise<void>;
}

export function resolveDetailMaxBytes(configValue?: number): number {
  const envRaw = process.env['HIVE_AUDIT_DETAIL_MAX_BYTES'];
  let configured: number;
  if (configValue !== undefined) {
    configured = configValue;
  } else if (envRaw !== undefined && envRaw !== '') {
    const parsed = Number(envRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(`HIVE_AUDIT_DETAIL_MAX_BYTES must be a positive integer, got: ${envRaw}`);
    }
    configured = parsed;
  } else {
    configured = SCHEMA_DETAIL_HARD_CEILING_BYTES;
  }
  // Clamp at the schema ceiling — operator can lower, never exceed.
  return Math.min(configured, SCHEMA_DETAIL_HARD_CEILING_BYTES);
}

interface SerializedDetail {
  text: string | null;
  truncated: boolean;
}

function serializeDetail(
  detail: Record<string, unknown> | null,
  maxBytes: number,
): SerializedDetail {
  if (detail === null) return { text: null, truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return { text: null, truncated: true };
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return { text: null, truncated: true };
  }
  return { text: serialized, truncated: false };
}

function logRecordFailure(
  logger: Logger,
  event: NewAuditEvent,
  err: unknown,
  occurredAt: Date,
): void {
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  const errorMessage = err instanceof Error ? err.message : String(err);
  logger.error(
    {
      event: 'audit_record_failure',
      category: event.category,
      actorId: event.actorId,
      subjectId: event.subjectId,
      reasonCode: event.reasonCode,
      errorClass,
      errorMessage,
      requestId: event.requestId,
      occurredAt: occurredAt.toISOString(),
      hiveId: event.hiveId,
    },
    'audit_log INSERT failed — event dropped',
  );
}

function logDetailOverflow(logger: Logger, event: NewAuditEvent, maxBytes: number): void {
  logger.warn(
    {
      event: 'audit_record_detail_overflow',
      category: event.category,
      actorId: event.actorId,
      subjectId: event.subjectId,
      reasonCode: event.reasonCode,
      hiveId: event.hiveId,
      maxBytes,
    },
    'audit detail exceeds size cap — persisted with NULL detail',
  );
}

export function createAuditRecorder(
  deps: RecorderDeps,
  config: RecorderConfig = {},
): AuditRecorder {
  const detailMaxBytes = resolveDetailMaxBytes(config.detailMaxBytes);
  const now = deps.now ?? ((): Date => new Date());
  const idGen = deps.idGen ?? uuidv7;

  function buildInsertInput(event: NewAuditEvent): InsertAuditEventInput {
    const createdAt = now();
    const serialized = serializeDetail(event.detail, detailMaxBytes);
    if (serialized.truncated) {
      logDetailOverflow(deps.logger, event, detailMaxBytes);
    }
    return {
      id: idGen(),
      hiveId: event.hiveId,
      occurredAt: event.occurredAt,
      createdAt,
      category: event.category,
      decision: event.decision,
      actorId: event.actorId,
      actorKind: event.actorKind,
      subjectId: event.subjectId,
      subjectKind: event.subjectKind,
      reasonCode: event.reasonCode,
      detail: serialized.text,
      requestId: event.requestId,
    };
  }

  return {
    async recordEvent(event) {
      const input = buildInsertInput(event);
      try {
        await deps.auditRepo.insertAuditEvent(input);
      } catch (err) {
        incrementFailureCounter(event.category);
        logRecordFailure(deps.logger, event, err, input.createdAt);
      }
    },

    async recordEventBatch(events) {
      if (events.length === 0) return;
      const inputs = events.map(buildInsertInput);
      try {
        await deps.auditRepo.insertAuditEventBatch(inputs);
      } catch (err) {
        // Batch failure: increment per category occurrence, log once per event for
        // forensic parity with the single-record path.
        for (const e of events) {
          incrementFailureCounter(e.category);
          logRecordFailure(deps.logger, e, err, new Date());
        }
      }
    },
  };
}
