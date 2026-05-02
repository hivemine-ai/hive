// `hivectl credential rotate <jti-or-active-ref> [--ttl <duration>] [--yes]
//   [--output-credential <path>]`
//
// `<jti-or-active-ref>` accepts either a UUID v7 JTI (canonical) or a
// `<participant-ref>:latest` alias resolving to that participant's currently-
// active credential — per ADR-020 Q3=3B + PRY-041 of the cascade.

import { writeFileSync } from 'node:fs';

import type { CliRuntime, IssuedCredential, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { parseDuration } from '#input/parse-duration.js';
import { resolveCredentialRef } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import type { GlobalCliOpts } from '#types.js';

export interface RotateCredentialOpts {
  globals: GlobalCliOpts;
  jti: string;
  ttl: string | undefined;
  outputCredential: string | undefined;
}

export interface RotateCredentialResult {
  newJti: UUIDv7;
  oldJti: UUIDv7;
  expiresAt: Date;
  kid: string;
  credentialPath: string | null;
  credentialJwt?: string;
}

export async function runRotateCredential(
  runtime: CliRuntime,
  opts: RotateCredentialOpts,
): Promise<RotateCredentialResult> {
  if (!opts.globals.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: 'credential rotate revokes the current jti; pass --yes to confirm',
    });
  }
  const oldJti = await resolveCredentialRef(opts.jti, runtime);
  const actor = await buildOperatorActor(opts.globals, runtime);
  const ttlMs = opts.ttl !== undefined ? parseDuration(opts.ttl) : undefined;

  const rotateInput: Parameters<typeof runtime.rotator.rotateCredential>[0] = {
    currentJti: oldJti,
  };
  if (ttlMs !== undefined) rotateInput.ttl = ttlMs;
  if (actor.actorId !== null) rotateInput.requestedBy = actor.actorId;
  const credential: IssuedCredential = await runtime.rotator.rotateCredential(rotateInput);

  await runtime.auditRecorder.recordEvent({
    category: 'admin_credential_rotate',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: credential.jti,
    subjectKind: 'credential',
    reasonCode: null,
    detail: { ...actor.detail, oldJti, kid: credential.kid },
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  let credentialPath: string | null = null;
  if (opts.outputCredential !== undefined && opts.outputCredential !== '') {
    writeFileSync(opts.outputCredential, credential.jwt, { mode: 0o600 });
    credentialPath = opts.outputCredential;
  }

  const out: RotateCredentialResult = {
    newJti: credential.jti,
    oldJti,
    expiresAt: credential.expiresAt,
    kid: credential.kid,
    credentialPath,
  };
  if (credentialPath === null) out.credentialJwt = credential.jwt;
  return out;
}
