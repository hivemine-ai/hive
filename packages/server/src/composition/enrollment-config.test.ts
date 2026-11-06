import { describe, expect, it } from 'vitest';

import { resolveEnrollmentConfigFromEnv } from './enrollment-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('resolveEnrollmentConfigFromEnv', () => {
  it('applies the Auth + Identity defaults', () => {
    expect(resolveEnrollmentConfigFromEnv({})).toEqual({
      hiveMaxAgents: 10,
      enrollmentTtlMs: 90 * DAY_MS,
      workerTokenTtlMs: 3600 * 1000,
      holderProofWindowDays: 7,
    });
  });

  it('reads every variable', () => {
    expect(
      resolveEnrollmentConfigFromEnv({
        HIVE_ENROLLMENT_MAX_AGENTS: '25',
        HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS: '30',
        HIVE_WORKER_TOKEN_TTL_SECONDS: '600',
        HIVE_HOLDER_PROOF_WINDOW_DAYS: '0',
      }),
    ).toEqual({
      hiveMaxAgents: 25,
      enrollmentTtlMs: 30 * DAY_MS,
      workerTokenTtlMs: 600 * 1000,
      holderProofWindowDays: 0,
    });
  });

  it.each([
    ['HIVE_ENROLLMENT_MAX_AGENTS', '-1'],
    ['HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS', '0'],
    ['HIVE_WORKER_TOKEN_TTL_SECONDS', '59'],
    ['HIVE_HOLDER_PROOF_WINDOW_DAYS', '-1'],
    ['HIVE_ENROLLMENT_MAX_AGENTS', 'ten'],
  ])('fails fast on %s=%s', (name, value) => {
    expect(() => resolveEnrollmentConfigFromEnv({ [name]: value })).toThrow(name);
  });
});
