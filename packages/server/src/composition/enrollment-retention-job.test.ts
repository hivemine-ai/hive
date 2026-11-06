// PRY-094: scheduling of runEnrollmentRetention in the composition root (MCP Server tech
// spec § composition/wire.ts, step 13c). Fake timers drive the interval.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnrollmentRetentionPassError } from '#domain/auth/index.js';
import type { EnrollmentRetentionResult } from '#domain/auth/index.js';
import type { Logger } from '#observability/logger.js';

import { createEnrollmentRetentionJob } from './enrollment-retention-job.js';

const EMPTY: EnrollmentRetentionResult = {
  retiredAgentIds: [],
  revokedAgentIds: [],
  purgedTokenRows: 0,
};

function logger(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() } as never;
}

describe('enrollment retention job', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run at start; first run one interval later, then every interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(EMPTY);
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 60, logger: logger() });

    job.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);

    await job.stop();
  });

  it('is not scheduled with an interval of 0', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(EMPTY);
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 0, logger: logger() });

    job.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(run).not.toHaveBeenCalled();
    await job.stop();
  });

  it('skips a tick while the previous run is still going: no overlap', async () => {
    vi.useFakeTimers();
    let finish!: (value: EnrollmentRetentionResult) => void;
    const run = vi.fn(
      () =>
        new Promise<EnrollmentRetentionResult>((resolve) => {
          finish = resolve;
        }),
    );
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 10, logger: logger() });

    job.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    finish(EMPTY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    finish(EMPTY);
    await job.stop();
  });

  it('stop() cancels the timer and waits for the run in progress', async () => {
    vi.useFakeTimers();
    let finish!: (value: EnrollmentRetentionResult) => void;
    const run = vi.fn(
      () =>
        new Promise<EnrollmentRetentionResult>((resolve) => {
          finish = resolve;
        }),
    );
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 10, logger: logger() });
    job.start();
    await vi.advanceTimersByTimeAsync(10_000);

    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish(EMPTY);
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs a failed run as auth_enrollment_retention_failed with its pass and retries on the next interval', async () => {
    vi.useFakeTimers();
    const log = logger();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new EnrollmentRetentionPassError('grace', new Error('db down')))
      .mockResolvedValue({ ...EMPTY, retiredAgentIds: ['a'] });
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 10, logger: log });

    job.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth_enrollment_retention_failed',
        pass: 'grace',
        err: expect.stringContaining('db down') as unknown,
      }),
      expect.any(String),
    );
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth_enrollment_retention_completed',
        retired: 1,
        revoked: 0,
        purgedTokenRows: 0,
      }),
      expect.any(String),
    );
    await job.stop();
  });

  it('runOnce passes the clock to the run and never throws', async () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const log = logger();
    const job = createEnrollmentRetentionJob({ run, intervalSeconds: 0, logger: log });

    await expect(job.runOnce(now)).resolves.toBeNull();
    expect(run).toHaveBeenCalledWith(now);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_enrollment_retention_failed', pass: 'unknown' }),
      expect.any(String),
    );
  });
});
