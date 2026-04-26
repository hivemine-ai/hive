// `hivectl agent create --owner <email-or-id> --name <name> --type worker|scout
//   [--capability <cap>...] [--instructions <text>] [--emit-credential]
//   [--credential-ttl <duration>] [--output-credential <path>]`

import { writeFileSync } from 'node:fs';

import type { CliRuntime, IssuedCredential, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { parseDuration } from '#input/parse-duration.js';
import { resolveParticipantReference } from '#input/parse-reference.js';
import { buildOperatorActor } from '#audit/operator-actor.js';
import { toCallerContext } from '../hivekeeper/create.js';
import type { GlobalCliOpts } from '#types.js';

export interface CreateAgentOpts {
  globals: GlobalCliOpts;
  /** Email of a Hivekeeper or canonical UUIDv7. */
  owner: string;
  name: string;
  type: 'worker' | 'scout';
  capabilities: string[];
  instructions: string | undefined;
  emitCredential: boolean;
  credentialTtl: string | undefined;
  outputCredential: string | undefined;
}

export interface CreateAgentResult {
  agentId: UUIDv7;
  name: string;
  type: 'worker' | 'scout';
  ownerId: UUIDv7;
  credentialJti: string | null;
  credentialExpiresAt: Date | null;
  credentialPath: string | null;
  credentialJwt?: string;
}

export async function runCreateAgent(
  runtime: CliRuntime,
  opts: CreateAgentOpts,
): Promise<CreateAgentResult> {
  if (opts.name.trim() === '') {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'name_invalid',
      message: 'agent --name cannot be empty',
    });
  }
  if (opts.type !== 'worker' && opts.type !== 'scout') {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'type_invalid',
      message: `--type must be 'worker' or 'scout', got '${String(opts.type)}'`,
    });
  }
  const ownerId = await resolveParticipantReference(opts.owner, runtime);
  const actor = await buildOperatorActor(opts.globals, runtime);
  const caller = toCallerContext(actor);

  const createInput: Parameters<typeof runtime.participantsWriteRepo.createAgent>[0] = {
    hiveId: runtime.hiveStableIdentifier,
    colonyId: runtime.hiveColonyId,
    ownerId,
    name: opts.name,
    type: opts.type,
    capabilities: opts.capabilities,
  };
  if (opts.instructions !== undefined) createInput.instructions = opts.instructions;

  const agent = await runtime.participantsWriteRepo.createAgent(createInput, caller);

  await runtime.auditRecorder.recordEvent({
    category: 'admin_agent_create',
    decision: 'success',
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    subjectId: agent.id,
    subjectKind: 'participant',
    reasonCode: null,
    detail: { ...actor.detail, ownerId, type: opts.type },
    hiveId: runtime.hiveStableIdentifier,
    occurredAt: new Date(),
    requestId: null,
  });

  let credential: IssuedCredential | null = null;
  if (opts.emitCredential) {
    const ttlMs = opts.credentialTtl !== undefined ? parseDuration(opts.credentialTtl) : undefined;
    const issueInput: Parameters<typeof runtime.issuer.issueCredential>[0] = {
      participantId: agent.id,
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
      detail: { ...actor.detail, participantId: agent.id, kid: credential.kid },
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

  const out: CreateAgentResult = {
    agentId: agent.id,
    name: agent.name,
    type: agent.type,
    ownerId: agent.ownerId,
    credentialJti: credential ? credential.jti : null,
    credentialExpiresAt: credential ? credential.expiresAt : null,
    credentialPath,
  };
  if (credential && credentialPath === null) out.credentialJwt = credential.jwt;
  return out;
}
