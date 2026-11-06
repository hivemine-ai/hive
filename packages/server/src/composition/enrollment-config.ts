// ADR-026 Auth variables (Auth + Identity tech spec, environment variables catalog).
// Read by both the server and `hivectl`, which issues and revokes enrollment credentials
// in its own process. Invalid values fail fast at boot.

import { parseIntEnv } from '#observability/env.js';

export interface EnrollmentConfig {
  // HIVE_ENROLLMENT_MAX_AGENTS: ceiling of `--max-agents` and quota without the claim.
  hiveMaxAgents: number;
  // HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS, in milliseconds.
  enrollmentTtlMs: number;
  // HIVE_WORKER_TOKEN_TTL_SECONDS, in milliseconds.
  workerTokenTtlMs: number;
  // HIVE_HOLDER_PROOF_WINDOW_DAYS. 0 accepts only Worker tokens that are still valid.
  holderProofWindowDays: number;
}

export function resolveEnrollmentConfigFromEnv(env: NodeJS.ProcessEnv): EnrollmentConfig {
  const ttlDays = parseIntEnv(env['HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS'], 90, {
    name: 'HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS',
    min: 1,
  });
  const workerTtlSeconds = parseIntEnv(env['HIVE_WORKER_TOKEN_TTL_SECONDS'], 3600, {
    name: 'HIVE_WORKER_TOKEN_TTL_SECONDS',
    min: 60,
  });
  return {
    hiveMaxAgents: parseIntEnv(env['HIVE_ENROLLMENT_MAX_AGENTS'], 10, {
      name: 'HIVE_ENROLLMENT_MAX_AGENTS',
      min: 0,
    }),
    enrollmentTtlMs: ttlDays * 24 * 60 * 60 * 1000,
    workerTokenTtlMs: workerTtlSeconds * 1000,
    holderProofWindowDays: parseIntEnv(env['HIVE_HOLDER_PROOF_WINDOW_DAYS'], 7, {
      name: 'HIVE_HOLDER_PROOF_WINDOW_DAYS',
      min: 0,
    }),
  };
}
