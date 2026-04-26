// Resolve a participant reference to a canonical UUIDv7.
//
// Slice 0 accepts:
//   (a) UUID v7 canonical → returned as-is (lowercased).
//   (b) Email (Hivekeeper) → looked up by lower(email).
//
// Per the tech spec § "Decisión: hivectl no acepta referencia humana de Agent",
// agent references like '<name>@<owner>.<hive>' are NOT supported by the CLI.
// Operators copy the agent UUID from `agent list`.
//
// Errors:
//   - Unparseable input        → CliError('CONFIG_INVALID', 'reference_unparseable')
//   - Email present but no row → AuthError('PARTICIPANT_NOT_FOUND', 'email_not_found')

import { AuthError } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '../error/cli-error.js';
import { isUuidV7, parseUuidV7 } from './parse-uuid.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParticipantReferenceKind = 'uuid' | 'email';

export interface ParsedParticipantReference {
  kind: ParticipantReferenceKind;
  raw: string;
}

export function parseParticipantReference(input: string): ParsedParticipantReference {
  const trimmed = input.trim();
  if (isUuidV7(trimmed)) {
    return { kind: 'uuid', raw: trimmed.toLowerCase() };
  }
  if (EMAIL_PATTERN.test(trimmed)) {
    return { kind: 'email', raw: trimmed };
  }
  throw new CliError('CONFIG_INVALID', {
    subCode: 'reference_unparseable',
    message: `'${input}' is neither a UUID v7 nor a valid email`,
  });
}

/**
 * Resolve any of the supported reference forms to a canonical participantId.
 * Email lookups search the Hivekeeper table only — agents do not have email
 * identities in v0.1.
 */
export async function resolveParticipantReference(
  input: string,
  runtime: CliRuntime,
): Promise<UUIDv7> {
  const ref = parseParticipantReference(input);
  if (ref.kind === 'uuid') {
    return parseUuidV7(ref.raw);
  }
  const keeper = await runtime.participantsRepo.findHivekeeperByEmail(
    runtime.hiveStableIdentifier,
    ref.raw,
  );
  if (!keeper) {
    throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'email_not_found' });
  }
  return keeper.id;
}
