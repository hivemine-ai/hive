// `hivectl agent list [--owner <ref>] [--type worker|scout] [--state ...]
//   [--limit N] [--cursor <cursor>]` — read-only, no audit event.

import type { CliRuntime, UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import { resolveParticipantReference } from '#input/parse-reference.js';
import type { GlobalCliOpts } from '#types.js';

export type AgentState = 'active' | 'suspended' | 'revoked';

export interface ListAgentsOpts {
  globals: GlobalCliOpts;
  /** UUIDv7 or email of a Hivekeeper. */
  owner: string | undefined;
  type: 'worker' | 'scout' | undefined;
  state: AgentState | undefined;
  limit: number | undefined;
  cursor: string | undefined;
}

export interface ListedAgent {
  id: UUIDv7;
  name: string;
  type: 'worker' | 'scout';
  ownerId: UUIDv7;
  state: AgentState;
  capabilities: string[];
  createdAt: Date;
}

export async function runListAgents(
  runtime: CliRuntime,
  opts: ListAgentsOpts,
): Promise<{ agents: ListedAgent[]; nextCursor: string | null }> {
  const filter: Parameters<typeof runtime.participantsRepo.listAgents>[0] = {
    hiveId: runtime.hiveStableIdentifier,
    pagination: { cursor: parseCursor(opts.cursor), limit: opts.limit ?? 50 },
  };
  if (opts.owner !== undefined) {
    filter.ownerId = await resolveParticipantReference(opts.owner, runtime);
  }
  if (opts.type !== undefined) filter.type = opts.type;
  if (opts.state !== undefined) filter.state = opts.state;

  const result = await runtime.participantsRepo.listAgents(filter);
  return {
    agents: result.agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      ownerId: a.ownerId,
      state: a.state,
      capabilities: a.capabilities,
      createdAt: a.createdAt,
    })),
    nextCursor: result.nextCursor !== null ? serializeCursor(result.nextCursor) : null,
  };
}

function parseCursor(input: string | undefined): { createdAt: Date; id: UUIDv7 } | null {
  if (input === undefined || input === '') return null;
  // Cursor is opaque base64 of `<isoCreatedAt>|<id>`. A malformed cursor MUST
  // throw — silently returning the first page would mislead an operator who
  // typo'd a character into thinking they were on page N.
  const decoded = Buffer.from(input, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep <= 0) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'cursor_malformed',
      message: `--cursor '${input}' is not a valid pagination cursor`,
    });
  }
  const isoPart = decoded.slice(0, sep);
  const idPart = decoded.slice(sep + 1);
  const date = new Date(isoPart);
  if (Number.isNaN(date.getTime())) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'cursor_malformed',
      message: `--cursor '${input}' has an invalid timestamp component`,
    });
  }
  return { createdAt: date, id: idPart };
}

function serializeCursor(cursor: { createdAt: Date; id: UUIDv7 }): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}
