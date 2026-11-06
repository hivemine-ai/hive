// `hivectl credential rotate <jti-or-active-ref> [--ttl <duration>] [--yes]
//   [--output-credential <path>]`
//
// `<jti-or-active-ref>` accepts either a UUID v7 JTI (canonical) or a
// `<participant-ref>:latest` alias resolving to that participant's currently-
// active credential — per ADR-020 Q3=3B + PRY-041 of the cascade.
//
// ADR-026: an enrollment credential rotates into one with the same scope and claims; its
// Worker tokens keep renewing, and the old credential stops registering sessions. The new
// one must go to `--output-credential`.

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
  const isEnrollment = await isEnrollmentCredential(runtime, oldJti);
  if (isEnrollment && (opts.outputCredential === undefined || opts.outputCredential === '')) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'output_credential_required',
      message: 'rotating an enrollment credential requires --output-credential <path>',
    });
  }
  const actor = await buildOperatorActor(opts.globals, runtime);
  const ttlMs = opts.ttl !== undefined ? parseDuration(opts.ttl) : undefined;

  const rotateInput: Parameters<typeof runtime.rotator.rotateCredential>[0] = {
    currentJti: oldJti,
  };
  if (ttlMs !== undefined) rotateInput.ttl = ttlMs;
  if (actor.actorId !== null) rotateInput.requestedBy = actor.actorId;
  const credential: IssuedCredential = await runtime.rotator.rotateCredential(rotateInput);

  await runtime.auditRecorder.recordEvent({
    category: isEnrollment ? 'enrollment_credential_rotated' : 'admin_credential_rotate',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    // The enrollment event is about the old credential (Visibility Engine + Audit Log).
    subjectId: isEnrollment ? oldJti : credential.jti,
    subjectKind: 'credential',
    reasonCode: null,
    detail: isEnrollment
      ? { ...actor.detail, newJti: credential.jti, kid: credential.kid }
      : { ...actor.detail, oldJti, kid: credential.kid },
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

export async function isEnrollmentCredential(runtime: CliRuntime, jti: UUIDv7): Promise<boolean> {
  const row = await runtime.db
    .selectFrom('credentials')
    .select('scope')
    .where('jti', '=', jti)
    .executeTakeFirst();
  return row?.scope === 'enroll';
}
