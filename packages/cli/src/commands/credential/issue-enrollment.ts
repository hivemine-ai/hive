// `hivectl credential issue --enrollment --owner <email-or-uuid> [--name-prefix <p>]
//   [--max-agents N] [--ttl <duration>] [--reason <text>] --output-credential <path>`
//
// ADR-026: an enrollment credential is a long-lived secret, so it is only ever written to
// a file (0600), never to stdout. The domain enforces the claims (name prefix syntax,
// `--max-agents` against HIVE_ENROLLMENT_MAX_AGENTS).

import { writeFileSync } from 'node:fs';

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { toCallerContext } from '#commands/hivekeeper/create.js';
import { CliError } from '#error/cli-error.js';
import { parseDuration } from '#input/parse-duration.js';
import { resolveParticipantReference } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import type { GlobalCliOpts } from '#types.js';

export interface IssueEnrollmentCredentialOpts {
  globals: GlobalCliOpts;
  ownerRef: string;
  namePrefix: string | undefined;
  maxAgents: string | undefined;
  ttl: string | undefined;
  reason: string | undefined;
  outputCredential: string | undefined;
}

export interface IssueEnrollmentCredentialResult {
  jti: UUIDv7;
  ownerId: UUIDv7;
  scope: 'enroll';
  namePrefix: string | null;
  maxAgents: number | null;
  expiresAt: Date;
  kid: string;
  credentialPath: string;
  nextStep: string;
}

export async function runIssueEnrollmentCredential(
  runtime: CliRuntime,
  opts: IssueEnrollmentCredentialOpts,
): Promise<IssueEnrollmentCredentialResult> {
  const credentialPath = opts.outputCredential;
  if (credentialPath === undefined || credentialPath === '') {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'output_credential_required',
      message: 'credential issue --enrollment requires --output-credential <path>',
    });
  }
  const maxAgents = opts.maxAgents !== undefined ? parseMaxAgents(opts.maxAgents) : undefined;
  const ownerId = await resolveParticipantReference(opts.ownerRef, runtime);
  const actor = await buildOperatorActor(opts.globals, runtime);
  const ttlMs = opts.ttl !== undefined ? parseDuration(opts.ttl) : undefined;

  const credential = await runtime.enrollment.issueEnrollmentCredential(
    {
      ownerId,
      ...(opts.namePrefix !== undefined ? { namePrefix: opts.namePrefix } : {}),
      ...(maxAgents !== undefined ? { maxAgents } : {}),
      ...(ttlMs !== undefined ? { ttl: ttlMs } : {}),
    },
    toCallerContext(actor),
  );
  writeFileSync(credentialPath, credential.jwt, { mode: 0o600 });

  const detail: Record<string, unknown> = {
    ...actor.detail,
    ownerId,
    expiresAt: credential.expiresAt.toISOString(),
  };
  if (opts.namePrefix !== undefined) detail['name_prefix'] = opts.namePrefix;
  if (maxAgents !== undefined) detail['max_agents'] = maxAgents;
  if (opts.ttl !== undefined) detail['ttl'] = opts.ttl;
  if (opts.reason !== undefined && opts.reason !== '') detail['reason'] = opts.reason;
  await runtime.auditRecorder.recordEvent({
    category: 'enrollment_credential_issued',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: credential.jti,
    subjectKind: 'credential',
    reasonCode: null,
    detail,
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  return {
    jti: credential.jti,
    ownerId,
    scope: 'enroll',
    namePrefix: opts.namePrefix ?? null,
    maxAgents: maxAgents ?? null,
    expiresAt: credential.expiresAt,
    kid: credential.kid,
    credentialPath,
    nextStep: `hivectl claude install --server <url> --enrollment-credential ${credentialPath}`,
  };
}

function parseMaxAgents(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'max_agents_not_integer',
      message: `--max-agents must be a positive integer (got ${JSON.stringify(raw)})`,
    });
  }
  return value;
}
