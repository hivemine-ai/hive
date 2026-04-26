// `hivectl credential issue --participant-id <ref> [--ttl <duration>]
//   [--reason <text>] [--output-credential <path>]`

import { writeFileSync } from 'node:fs';

import type { CliRuntime, IssuedCredential, UUIDv7 } from '@hive/server';

import { parseDuration } from '#input/parse-duration.js';
import { resolveParticipantReference } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import type { GlobalCliOpts } from '#types.js';

export interface IssueCredentialOpts {
  globals: GlobalCliOpts;
  participantRef: string;
  ttl: string | undefined;
  reason: string | undefined;
  outputCredential: string | undefined;
}

export interface IssueCredentialResult {
  jti: UUIDv7;
  participantId: UUIDv7;
  expiresAt: Date;
  kid: string;
  credentialPath: string | null;
  credentialJwt?: string;
}

export async function runIssueCredential(
  runtime: CliRuntime,
  opts: IssueCredentialOpts,
): Promise<IssueCredentialResult> {
  const participantId = await resolveParticipantReference(opts.participantRef, runtime);
  const actor = await buildOperatorActor(opts.globals, runtime);
  const ttlMs = opts.ttl !== undefined ? parseDuration(opts.ttl) : undefined;

  const issueInput: Parameters<typeof runtime.issuer.issueCredential>[0] = { participantId };
  if (ttlMs !== undefined) issueInput.ttl = ttlMs;
  if (actor.actorId !== null) issueInput.issuedBy = actor.actorId;
  const credential: IssuedCredential = await runtime.issuer.issueCredential(issueInput);

  const detail: Record<string, unknown> = {
    ...actor.detail,
    participantId,
    kid: credential.kid,
  };
  if (opts.reason !== undefined && opts.reason !== '') detail['reason'] = opts.reason;
  await runtime.auditRecorder.recordEvent({
    category: 'admin_credential_issue',
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

  let credentialPath: string | null = null;
  if (opts.outputCredential !== undefined && opts.outputCredential !== '') {
    writeFileSync(opts.outputCredential, credential.jwt, { mode: 0o600 });
    credentialPath = opts.outputCredential;
  }

  const out: IssueCredentialResult = {
    jti: credential.jti,
    participantId,
    expiresAt: credential.expiresAt,
    kid: credential.kid,
    credentialPath,
  };
  if (credentialPath === null) out.credentialJwt = credential.jwt;
  return out;
}
