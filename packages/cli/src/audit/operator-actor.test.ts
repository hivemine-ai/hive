import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliRuntime, Hivekeeper } from '@hive/server';

import { CliError } from '#error/cli-error.js';
import type { GlobalCliOpts } from '../types.js';

import { buildOperatorActor } from './operator-actor.js';

const VALID_UUID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100';
const HIVE_ID = '019de8c4-b3c3-7279-a2ee-09424384da11';
const HIVE_NAME = 'cotalker';

interface MockRuntime {
  hiveStableIdentifier: string;
  hiveName: string;
  participantsRepo: {
    findHivekeeperById: Mock;
    findHivekeeperByEmail: Mock;
  };
}

function makeRuntime(overrides?: { findHivekeeperById?: Mock; findHivekeeperByEmail?: Mock }): {
  runtime: CliRuntime;
  findHivekeeperById: Mock;
  findHivekeeperByEmail: Mock;
} {
  const findHivekeeperById = overrides?.findHivekeeperById ?? vi.fn().mockResolvedValue(null);
  const findHivekeeperByEmail = overrides?.findHivekeeperByEmail ?? vi.fn().mockResolvedValue(null);
  const runtime: MockRuntime = {
    hiveStableIdentifier: HIVE_ID,
    hiveName: HIVE_NAME,
    participantsRepo: { findHivekeeperById, findHivekeeperByEmail },
  };
  return {
    runtime: runtime as unknown as CliRuntime,
    findHivekeeperById,
    findHivekeeperByEmail,
  };
}

function makeAdmin(id: string): Hivekeeper {
  return {
    id,
    hiveId: HIVE_ID,
    colonyId: '019de8c4-b3c3-7279-a2ee-09424384da12',
    email: 'admin@example.com',
    displayName: null,
    isAdmin: true,
    state: 'active',
    createdAt: new Date(),
    revokedAt: null,
  };
}

function makeGlobals(overrides?: Partial<GlobalCliOpts>): GlobalCliOpts {
  return {
    output: 'json',
    yes: false,
    noColor: false,
    verbose: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('buildOperatorActor', () => {
  it('returns system actor when --operator-id is absent', async () => {
    const { runtime, findHivekeeperById, findHivekeeperByEmail } = makeRuntime();
    const actor = await buildOperatorActor(makeGlobals(), runtime);
    expect(actor.actorKind).toBe('system');
    expect(actor.actorId).toBeNull();
    expect(findHivekeeperById).not.toHaveBeenCalled();
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
  });

  it('UUID v7 input bypasses email lookup and validates as Hivekeeper', async () => {
    const { runtime, findHivekeeperById, findHivekeeperByEmail } = makeRuntime({
      findHivekeeperById: vi.fn().mockResolvedValue(makeAdmin(VALID_UUID)),
    });
    const actor = await buildOperatorActor(makeGlobals({ operatorId: VALID_UUID }), runtime);
    expect(actor.actorKind).toBe('hivekeeper');
    expect(actor.actorId).toBe(VALID_UUID);
    expect(findHivekeeperById).toHaveBeenCalledWith(VALID_UUID);
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
  });

  it('hivekeeper email resolves via email lookup then admin validation', async () => {
    const admin = makeAdmin(VALID_UUID);
    const { runtime, findHivekeeperById, findHivekeeperByEmail } = makeRuntime({
      findHivekeeperByEmail: vi.fn().mockResolvedValue(admin),
      findHivekeeperById: vi.fn().mockResolvedValue(admin),
    });
    const actor = await buildOperatorActor(makeGlobals({ operatorId: 'me@example.com' }), runtime);
    expect(actor.actorKind).toBe('hivekeeper');
    expect(actor.actorId).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).toHaveBeenCalledWith(HIVE_ID, 'me@example.com');
    expect(findHivekeeperById).toHaveBeenCalledWith(VALID_UUID);
  });

  it('email not found maps to OPERATOR_ID_NOT_ADMIN(not_found)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: 'ghost@example.com' }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_NOT_ADMIN');
      expect(e.subCode).toBe('not_found');
      return true;
    });
  });

  it('UUID resolves but Hivekeeper does not exist → OPERATOR_ID_NOT_ADMIN(not_found)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: VALID_UUID }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_NOT_ADMIN');
      expect(e.subCode).toBe('not_found');
      return true;
    });
  });

  it('Hivekeeper found but state !== active → OPERATOR_ID_NOT_ADMIN(not_active)', async () => {
    const suspended = { ...makeAdmin(VALID_UUID), state: 'suspended' as const };
    const { runtime } = makeRuntime({
      findHivekeeperById: vi.fn().mockResolvedValue(suspended),
    });
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: VALID_UUID }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_NOT_ADMIN');
      expect(e.subCode).toBe('not_active');
      return true;
    });
  });

  it('Hivekeeper found, active, but not admin → OPERATOR_ID_NOT_ADMIN(not_admin)', async () => {
    const nonAdmin = { ...makeAdmin(VALID_UUID), isAdmin: false };
    const { runtime } = makeRuntime({
      findHivekeeperById: vi.fn().mockResolvedValue(nonAdmin),
    });
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: VALID_UUID }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_NOT_ADMIN');
      expect(e.subCode).toBe('not_admin');
      return true;
    });
  });

  it('malformed reference throws CliError(OPERATOR_ID_INVALID, malformed_reference)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: 'garbage' }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_INVALID');
      expect(e.subCode).toBe('malformed_reference');
      return true;
    });
  });

  it('agent-reference syntax throws CliError(OPERATOR_ID_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      buildOperatorActor(makeGlobals({ operatorId: 'worker@admin.cotalker' }), runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_INVALID');
      expect(e.subCode).toBe('kind_not_allowed');
      return true;
    });
  });

  it('detail carries cliVersion and operatorNote (truncated when oversized)', async () => {
    const admin = makeAdmin(VALID_UUID);
    const { runtime } = makeRuntime({
      findHivekeeperById: vi.fn().mockResolvedValue(admin),
    });
    const actor = await buildOperatorActor(
      makeGlobals({ operatorId: VALID_UUID, operatorNote: 'investigation' }),
      runtime,
    );
    expect(actor.detail).toMatchObject({
      cliVersion: '0.1.0-dev',
      operatorNote: 'investigation',
    });
  });
});
