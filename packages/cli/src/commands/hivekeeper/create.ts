// `hivectl hivekeeper create --email <email> [--display-name <n>] [--admin]
//   [--emit-credential] [--credential-ttl <duration>] [--output-credential <path>]`
//
// Always emits `admin_hivekeeper_create`. With `--emit-credential`, also issues
// a credential and emits `admin_credential_issue`. The Hivekeeper's Cell is
// created cross-domain via `cellsHook` inside the same TX as the participant
// write (per PRY-002 wiring + PRY-003 hook adapter).

import { writeFileSync } from 'node:fs';

import type { CallerContext, CliRuntime, IssuedCredential, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { parseDuration } from '#input/parse-duration.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import type { GlobalCliOpts, OperatorActor } from '#types.js';

export interface CreateHivekeeperOpts {
  globals: GlobalCliOpts;
  email: string;
  displayName: string | undefined;
  admin: boolean;
  emitCredential: boolean;
  credentialTtl: string | undefined;
  outputCredential: string | undefined;
}

export interface CreateHivekeeperResult {
  hivekeeperId: UUIDv7;
  email: string;
  isAdmin: boolean;
  displayName: string | null;
  credentialJti: string | null;
  credentialExpiresAt: Date | null;
  credentialPath: string | null;
  credentialJwt?: string;
}

export async function runCreateHivekeeper(
  runtime: CliRuntime,
  opts: CreateHivekeeperOpts,
): Promise<CreateHivekeeperResult> {
  if (!isPlausibleEmail(opts.email)) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'email_invalid',
      message: `'${opts.email}' is not a valid email`,
    });
  }
  const actor = await buildOperatorActor(opts.globals, runtime);
  const caller = toCallerContext(actor);

  const createInput: Parameters<typeof runtime.participantsWriteRepo.createHivekeeper>[0] = {
    hiveId: runtime.hiveStableIdentifier,
    colonyId: runtime.hiveColonyId,
    email: opts.email,
    isAdmin: opts.admin,
  };
  if (opts.displayName !== undefined) createInput.displayName = opts.displayName;

  const keeper = await runtime.participantsWriteRepo.createHivekeeper(createInput, caller);

  await runtime.auditRecorder.recordEvent({
    category: 'admin_hivekeeper_create',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: keeper.id,
    subjectKind: 'participant',
    reasonCode: null,
    detail: actor.detail,
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  let credential: IssuedCredential | null = null;
  if (opts.emitCredential) {
    const ttlMs = opts.credentialTtl !== undefined ? parseDuration(opts.credentialTtl) : undefined;
    const issueInput: Parameters<typeof runtime.issuer.issueCredential>[0] = {
      participantId: keeper.id,
    };
    if (ttlMs !== undefined) issueInput.ttl = ttlMs;
    if (actor.actorId !== null) issueInput.issuedBy = actor.actorId;
    credential = await runtime.issuer.issueCredential(issueInput);
    await runtime.auditRecorder.recordEvent({
      category: 'admin_credential_issue',
      decision: 'success',
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      subjectId: credential.jti,
      subjectKind: 'credential',
      reasonCode: null,
      detail: { ...actor.detail, participantId: keeper.id, kid: credential.kid },
      hiveId: runtime.hiveStableIdentifier,
      occurredAt: new Date(),
      requestId: null,
    });
  }

  let credentialPath: string | null = null;
  if (credential && opts.outputCredential !== undefined && opts.outputCredential !== '') {
    writeFileSync(opts.outputCredential, credential.jwt, { mode: 0o600 });
    credentialPath = opts.outputCredential;
  }

  const out: CreateHivekeeperResult = {
    hivekeeperId: keeper.id,
    email: keeper.email,
    isAdmin: keeper.isAdmin,
    displayName: keeper.displayName,
    credentialJti: credential ? credential.jti : null,
    credentialExpiresAt: credential ? credential.expiresAt : null,
    credentialPath,
  };
  if (credential && credentialPath === null) out.credentialJwt = credential.jwt;
  return out;
}

/**
 * Map the CLI's `OperatorActor` to a domain `CallerContext`. Always returns
 * a `system` caller in Slice 0: the CLI cannot synthesize a full
 * `IdentityContext` (capabilities, currentState, snapshot) from `--operator-id`
 * alone — only the verifier can. The audit log records the operator
 * authoritatively via `actorId` + `actorKind` ('hivekeeper' when the flag
 * resolves; 'system' otherwise) — see `audit/operator-actor.ts`. The Slice 1+
 * authenticated path will branch here once the verifier surface accepts a
 * synthesized identity.
 */
export function toCallerContext(actor: OperatorActor): CallerContext {
  const caller: CallerContext = { kind: 'system' };
  const osUser = actor.detail['osUser'];
  const operatorNote = actor.detail['operatorNote'];
  if (typeof osUser === 'string') caller.osUser = osUser;
  if (typeof operatorNote === 'string') caller.operatorNote = operatorNote;
  return caller;
}

function isPlausibleEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
