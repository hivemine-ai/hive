// In-process schedule of runEnrollmentRetention (MCP Server + Tool Surface tech spec
// § composition/wire.ts, step 13c; ADR-026). First run one interval after start, then
// every interval; a tick while a run is in progress is skipped (no overlap). A failed run
// is logged and only retried on the next interval. `stop()` cancels the timer and waits
// for the run in progress, inside the shutdown drain.

import { EnrollmentRetentionPassError } from '#domain/auth/index.js';
import type { EnrollmentRetentionResult } from '#domain/auth/index.js';
import type { Logger } from '#observability/logger.js';

export interface EnrollmentRetentionJobDeps {
  run: (now: Date) => Promise<EnrollmentRetentionResult>;
  // HIVE_ENROLLMENT_RETENTION_INTERVAL_SECONDS. 0: never scheduled.
  intervalSeconds: number;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

export interface EnrollmentRetentionJob {
  start(): void;
  stop(): Promise<void>;
  /**
   * One run now, or the run already in progress. Never throws: a failure is logged and
   * resolves to null. `now` overrides the clock (test seam).
   */
  runOnce(now?: Date): Promise<EnrollmentRetentionResult | null>;
}

export function createEnrollmentRetentionJob(
  deps: EnrollmentRetentionJobDeps,
): EnrollmentRetentionJob {
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<EnrollmentRetentionResult | null> | undefined;

  async function pass(now: Date): Promise<EnrollmentRetentionResult | null> {
    const startedAt = Date.now();
    try {
      const result = await deps.run(now);
      deps.logger.info(
        {
          event: 'auth_enrollment_retention_completed',
          retired: result.retiredAgentIds.length,
          revoked: result.revokedAgentIds.length,
          purgedTokenRows: result.purgedTokenRows,
          durationMs: Date.now() - startedAt,
        },
        'enrollment retention run completed',
      );
      return result;
    } catch (err) {
      deps.logger.warn(
        {
          event: 'auth_enrollment_retention_failed',
          pass: err instanceof EnrollmentRetentionPassError ? err.pass : 'unknown',
          err: err instanceof Error ? err.message : String(err),
        },
        'enrollment retention run failed; retrying on the next interval',
      );
      return null;
    }
  }

  function runOnce(now?: Date): Promise<EnrollmentRetentionResult | null> {
    running ??= pass(now ?? clock()).finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    runOnce,
    start() {
      if (deps.intervalSeconds <= 0 || timer !== undefined) return;
      timer = setInterval(() => {
        if (running === undefined) void runOnce();
      }, deps.intervalSeconds * 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
