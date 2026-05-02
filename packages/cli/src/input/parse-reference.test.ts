import { type Mock, describe, expect, it, vi } from 'vitest';

import { AuthError } from '@hive/server';
import type { Agent, CliRuntime, CredentialRow, Hivekeeper } from '@hive/server';

import { CliError } from '../error/cli-error.js';

import {
  parseParticipantReference,
  resolveAgentReference,
  resolveAuditParticipantReference,
  resolveCredentialRef,
  resolveOperatorId,
  resolveParticipantReference,
} from './parse-reference.js';

const VALID_UUID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100';
const AGENT_UUID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d201';
const OWNER_UUID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d300';
const CREDENTIAL_JTI = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d401';
const HIVE_ID = '019de8c4-b3c3-7279-a2ee-09424384da11';
const COLONY_ID = '019de8c4-b3c3-7279-a2ee-09424384da12';
const HIVE_NAME = 'cotalker';

interface MockRuntime {
  hiveStableIdentifier: string;
  hiveName: string;
  participantsRepo: {
    findHivekeeperByEmail: Mock;
    findHivekeeperByEmailLocalPart: Mock;
    findAgentByName: Mock;
  };
  credentialsRepo: {
    findActiveCredentialByParticipant: Mock;
  };
}

function makeRuntime(overrides?: {
  findHivekeeperByEmail?: Mock;
  findHivekeeperByEmailLocalPart?: Mock;
  findAgentByName?: Mock;
  findActiveCredentialByParticipant?: Mock;
}): {
  runtime: CliRuntime;
  findHivekeeperByEmail: Mock;
  findHivekeeperByEmailLocalPart: Mock;
  findAgentByName: Mock;
  findActiveCredentialByParticipant: Mock;
} {
  const findHivekeeperByEmail = overrides?.findHivekeeperByEmail ?? vi.fn().mockResolvedValue(null);
  const findHivekeeperByEmailLocalPart =
    overrides?.findHivekeeperByEmailLocalPart ?? vi.fn().mockResolvedValue(null);
  const findAgentByName = overrides?.findAgentByName ?? vi.fn().mockResolvedValue(null);
  const findActiveCredentialByParticipant =
    overrides?.findActiveCredentialByParticipant ?? vi.fn().mockResolvedValue(null);
  const runtime: MockRuntime = {
    hiveStableIdentifier: HIVE_ID,
    hiveName: HIVE_NAME,
    participantsRepo: { findHivekeeperByEmail, findHivekeeperByEmailLocalPart, findAgentByName },
    credentialsRepo: { findActiveCredentialByParticipant },
  };
  return {
    runtime: runtime as unknown as CliRuntime,
    findHivekeeperByEmail,
    findHivekeeperByEmailLocalPart,
    findAgentByName,
    findActiveCredentialByParticipant,
  };
}

function makeCredential(jti: string): CredentialRow {
  return {
    jti,
    participantId: OWNER_UUID,
    participantKind: 'hivekeeper',
    kid: 'kid-001',
    issuedAt: new Date(),
    notBefore: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    isRevoked: false,
    revokedAt: null,
  };
}

function makeHivekeeper(id: string): Hivekeeper {
  return {
    id,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    email: 'doesnt-matter@example.com',
    displayName: null,
    isAdmin: true,
    state: 'active',
    createdAt: new Date(),
    revokedAt: null,
  };
}

function makeAgent(id: string, ownerId: string, name = 'worker-a'): Agent {
  return {
    id,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId,
    name,
    type: 'worker',
    capabilities: [],
    instructions: '',
    state: 'active',
    createdAt: new Date(),
    revokedAt: null,
    lastConnectedAt: null,
  };
}

// ---------------------------------------------------------------------------
// parseParticipantReference (legacy 2-kind shape used by --owner / --participant-id)
// ---------------------------------------------------------------------------

describe('parseParticipantReference', () => {
  it('detects UUID v7', () => {
    const ref = parseParticipantReference(VALID_UUID, HIVE_NAME);
    expect(ref.kind).toBe('uuid');
    expect(ref.raw).toBe(VALID_UUID);
  });

  it('detects Hivekeeper email', () => {
    const ref = parseParticipantReference('admin@example.com', HIVE_NAME);
    expect(ref.kind).toBe('email');
    expect(ref.raw).toBe('admin@example.com');
  });

  it('lowercases UUID', () => {
    const ref = parseParticipantReference(VALID_UUID.toUpperCase(), HIVE_NAME);
    expect(ref.raw).toBe(VALID_UUID);
  });

  it('preserves email casing — DB lookup normalises downstream', () => {
    const ref = parseParticipantReference('Admin@Example.COM', HIVE_NAME);
    expect(ref.raw).toBe('Admin@Example.COM');
  });

  it('rejects garbage with reference_unparseable', () => {
    expect(() => parseParticipantReference('garbage', HIVE_NAME)).toThrow(
      /neither a UUID v7 nor a valid email/,
    );
    expect(() => parseParticipantReference('', HIVE_NAME)).toThrow(
      /neither a UUID v7 nor a valid email/,
    );
  });

  it('rejects agent-reference (out of scope for legacy callers — PRY-041/042 will widen)', () => {
    // worker@admin.cotalker matches the agent-reference shape because the suffix
    // .cotalker matches the hiveName. The 2-kind helper rejects it; PRY-041/042
    // will introduce a 3-kind helper that handles agent-reference.
    expect(() => parseParticipantReference('worker@admin.cotalker', HIVE_NAME)).toThrow(
      /neither a UUID v7 nor a valid email/,
    );
  });

  it('still resolves an email shape whose suffix does NOT match the hiveName', () => {
    const ref = parseParticipantReference('worker-a@admin.example.com', HIVE_NAME);
    expect(ref.kind).toBe('email');
    expect(ref.raw).toBe('worker-a@admin.example.com');
  });
});

// ---------------------------------------------------------------------------
// resolveParticipantReference — UUID + email path
// ---------------------------------------------------------------------------

describe('resolveParticipantReference', () => {
  it('returns UUID directly without DB lookup', async () => {
    const { runtime, findHivekeeperByEmail } = makeRuntime();
    const id = await resolveParticipantReference(VALID_UUID, runtime);
    expect(id).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
  });

  it('email shape resolves via findHivekeeperByEmail', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(makeHivekeeper(VALID_UUID));
    const { runtime } = makeRuntime({ findHivekeeperByEmail });
    const id = await resolveParticipantReference('admin@example.com', runtime);
    expect(id).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).toHaveBeenCalledWith(HIVE_ID, 'admin@example.com');
  });

  it('email not found throws AuthError(PARTICIPANT_NOT_FOUND)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveParticipantReference('nobody@example.com', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('email_not_found');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// resolveOperatorId — new helper for --operator-id flag (PRY-039)
// ---------------------------------------------------------------------------

describe('resolveOperatorId', () => {
  it('UUID v7 input passes through (no DB lookup; downstream validates admin)', async () => {
    const { runtime, findHivekeeperByEmail } = makeRuntime();
    const id = await resolveOperatorId(VALID_UUID, runtime);
    expect(id).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
  });

  it('UUID v7 in uppercase is normalised to lowercase', async () => {
    const { runtime } = makeRuntime();
    const id = await resolveOperatorId(VALID_UUID.toUpperCase(), runtime);
    expect(id).toBe(VALID_UUID);
  });

  it('hivekeeper email resolves via findHivekeeperByEmail', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(makeHivekeeper(VALID_UUID));
    const { runtime } = makeRuntime({ findHivekeeperByEmail });
    const id = await resolveOperatorId('me@example.com', runtime);
    expect(id).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).toHaveBeenCalledWith(HIVE_ID, 'me@example.com');
  });

  it('email not found throws AuthError(PARTICIPANT_NOT_FOUND, operator_email_not_found)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveOperatorId('ghost@example.com', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('operator_email_not_found');
        return true;
      },
    );
  });

  it('malformed input throws CliError(OPERATOR_ID_INVALID, malformed_reference)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveOperatorId('garbage', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_INVALID');
      expect(e.subCode).toBe('malformed_reference');
      return true;
    });
  });

  it('agent-reference syntax throws CliError(OPERATOR_ID_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    // worker@admin.cotalker is a valid agent-reference (suffix matches hiveName)
    // but operators must be Hivekeepers.
    await expect(resolveOperatorId('worker@admin.cotalker', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(CliError);
        const e = err as CliError;
        expect(e.code).toBe('OPERATOR_ID_INVALID');
        expect(e.subCode).toBe('kind_not_allowed');
        return true;
      },
    );
  });

  it('"self" alias throws CliError(OPERATOR_ID_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveOperatorId('self', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('OPERATOR_ID_INVALID');
      expect(e.subCode).toBe('kind_not_allowed');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAgentReference — UUID + agent-reference path (PRY-040)
// ---------------------------------------------------------------------------

describe('resolveAgentReference', () => {
  it('UUID v7 input passes through (no DB lookup; preserves repo idempotency)', async () => {
    const { runtime, findHivekeeperByEmailLocalPart, findAgentByName } = makeRuntime();
    const id = await resolveAgentReference(AGENT_UUID, runtime);
    expect(id).toBe(AGENT_UUID);
    expect(findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
    expect(findAgentByName).not.toHaveBeenCalled();
  });

  it('UUID v7 in uppercase is normalised to lowercase', async () => {
    const { runtime } = makeRuntime();
    const id = await resolveAgentReference(AGENT_UUID.toUpperCase(), runtime);
    expect(id).toBe(AGENT_UUID);
  });

  it('agent-reference resolves via findHivekeeperByEmailLocalPart + findAgentByName', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi.fn().mockResolvedValue(makeAgent(AGENT_UUID, OWNER_UUID));
    const { runtime } = makeRuntime({ findHivekeeperByEmailLocalPart, findAgentByName });

    const id = await resolveAgentReference('worker-a@admin.cotalker', runtime);

    expect(id).toBe(AGENT_UUID);
    expect(findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(HIVE_ID, 'admin');
    expect(findAgentByName).toHaveBeenCalledWith(HIVE_ID, OWNER_UUID, 'worker-a');
  });

  it('malformed input throws CliError(CONFIG_INVALID, agent_ref_unparseable)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveAgentReference('garbage', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('agent_ref_unparseable');
      return true;
    });
  });

  it('hivekeeper email throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    // admin@example.com is a valid Hivekeeper email but not an agent reference;
    // <agent-ref> only addresses Agents.
    await expect(resolveAgentReference('admin@example.com', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(CliError);
        const e = err as CliError;
        expect(e.code).toBe('CONFIG_INVALID');
        expect(e.subCode).toBe('kind_not_allowed');
        return true;
      },
    );
  });

  it('"self" alias throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveAgentReference('self', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('kind_not_allowed');
      return true;
    });
  });

  it('owner local-part not found throws AuthError(PARTICIPANT_NOT_FOUND, agent_owner_not_found)', async () => {
    const { runtime, findAgentByName } = makeRuntime();
    await expect(resolveAgentReference('worker-a@ghost.cotalker', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('agent_owner_not_found');
        return true;
      },
    );
    expect(findAgentByName).not.toHaveBeenCalled();
  });

  it('agent name not found under owner throws AuthError(PARTICIPANT_NOT_FOUND, agent_name_not_found)', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi.fn().mockResolvedValue(null);
    const { runtime } = makeRuntime({ findHivekeeperByEmailLocalPart, findAgentByName });

    await expect(resolveAgentReference('ghost@admin.cotalker', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('agent_name_not_found');
        return true;
      },
    );
    expect(findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(HIVE_ID, 'admin');
    expect(findAgentByName).toHaveBeenCalledWith(HIVE_ID, OWNER_UUID, 'ghost');
  });
});

// ---------------------------------------------------------------------------
// resolveCredentialRef — PRY-041 (`<jti-or-active-ref>` positional)
// ---------------------------------------------------------------------------

describe('resolveCredentialRef', () => {
  it('returns UUID directly without DB lookup (treated as a JTI)', async () => {
    const { runtime, findActiveCredentialByParticipant } = makeRuntime();
    const result = await resolveCredentialRef(VALID_UUID, runtime);
    expect(result).toBe(VALID_UUID);
    expect(findActiveCredentialByParticipant).not.toHaveBeenCalled();
  });

  it('lowercases UUID input on the JTI path', async () => {
    const { runtime } = makeRuntime();
    const result = await resolveCredentialRef(VALID_UUID.toUpperCase(), runtime);
    expect(result).toBe(VALID_UUID);
  });

  it('resolves `<email>:latest` to the active credential JTI', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findActiveCredentialByParticipant = vi
      .fn()
      .mockResolvedValue(makeCredential(CREDENTIAL_JTI));
    const { runtime } = makeRuntime({
      findHivekeeperByEmail,
      findActiveCredentialByParticipant,
    });

    const result = await resolveCredentialRef('admin@example.com:latest', runtime);

    expect(result).toBe(CREDENTIAL_JTI);
    expect(findHivekeeperByEmail).toHaveBeenCalledWith(HIVE_ID, 'admin@example.com');
    expect(findActiveCredentialByParticipant).toHaveBeenCalledWith(
      HIVE_ID,
      OWNER_UUID,
      expect.any(Date),
    );
  });

  it('resolves `<uuid>:latest` to the active credential JTI without resolving the participant', async () => {
    const findActiveCredentialByParticipant = vi
      .fn()
      .mockResolvedValue(makeCredential(CREDENTIAL_JTI));
    const { runtime, findHivekeeperByEmail } = makeRuntime({
      findActiveCredentialByParticipant,
    });

    const result = await resolveCredentialRef(`${OWNER_UUID}:latest`, runtime);

    expect(result).toBe(CREDENTIAL_JTI);
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
    expect(findActiveCredentialByParticipant).toHaveBeenCalledWith(
      HIVE_ID,
      OWNER_UUID,
      expect.any(Date),
    );
  });

  it('resolves `<agent>@<owner-local>.<hive>:latest` via owner local-part + agent name + active credential', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi
      .fn()
      .mockResolvedValue(makeAgent(AGENT_UUID, OWNER_UUID, 'worker-a'));
    const findActiveCredentialByParticipant = vi
      .fn()
      .mockResolvedValue(makeCredential(CREDENTIAL_JTI));
    const { runtime } = makeRuntime({
      findHivekeeperByEmailLocalPart,
      findAgentByName,
      findActiveCredentialByParticipant,
    });

    const result = await resolveCredentialRef(`worker-a@admin.${HIVE_NAME}:latest`, runtime);

    expect(result).toBe(CREDENTIAL_JTI);
    expect(findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(HIVE_ID, 'admin');
    expect(findAgentByName).toHaveBeenCalledWith(HIVE_ID, OWNER_UUID, 'worker-a');
    expect(findActiveCredentialByParticipant).toHaveBeenCalledWith(
      HIVE_ID,
      AGENT_UUID,
      expect.any(Date),
    );
  });

  it('garbage input throws CliError(CONFIG_INVALID, jti_or_ref_unparseable)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveCredentialRef('garbage', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('jti_or_ref_unparseable');
      return true;
    });
  });

  it('bare email (no `:latest`) throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveCredentialRef('admin@example.com', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(CliError);
        const e = err as CliError;
        expect(e.code).toBe('CONFIG_INVALID');
        expect(e.subCode).toBe('kind_not_allowed');
        return true;
      },
    );
  });

  it('"self" alias throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveCredentialRef('self', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('kind_not_allowed');
      return true;
    });
  });

  it('"self:latest" rejected by parser layer → CliError(CONFIG_INVALID, jti_or_ref_unparseable)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveCredentialRef('self:latest', runtime)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('jti_or_ref_unparseable');
      return true;
    });
  });

  it('email-not-found throws AuthError(PARTICIPANT_NOT_FOUND, credential_owner_not_found) before credential lookup', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(null);
    const { runtime, findActiveCredentialByParticipant } = makeRuntime({
      findHivekeeperByEmail,
    });

    await expect(resolveCredentialRef('ghost@example.com:latest', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('credential_owner_not_found');
        return true;
      },
    );
    expect(findActiveCredentialByParticipant).not.toHaveBeenCalled();
  });

  it('agent-name-not-found throws AuthError(PARTICIPANT_NOT_FOUND, credential_agent_not_found) before credential lookup', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi.fn().mockResolvedValue(null);
    const { runtime, findActiveCredentialByParticipant } = makeRuntime({
      findHivekeeperByEmailLocalPart,
      findAgentByName,
    });

    await expect(
      resolveCredentialRef(`ghost@admin.${HIVE_NAME}:latest`, runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthError);
      const e = err as AuthError;
      expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
      expect(e.subCode).toBe('credential_agent_not_found');
      return true;
    });
    expect(findActiveCredentialByParticipant).not.toHaveBeenCalled();
  });

  it('participant resolves but no active credential throws AuthError(PARTICIPANT_NOT_FOUND, no_active_credential)', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findActiveCredentialByParticipant = vi.fn().mockResolvedValue(null);
    const { runtime } = makeRuntime({
      findHivekeeperByEmail,
      findActiveCredentialByParticipant,
    });

    await expect(resolveCredentialRef('admin@example.com:latest', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
        expect(e.subCode).toBe('no_active_credential');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAuditParticipantReference — PRY-042 (`--actor-id` / `--subject-id`)
// ---------------------------------------------------------------------------

describe('resolveAuditParticipantReference', () => {
  it('UUID v7 input passes through (no DB lookup; audit_log queried by id-equality)', async () => {
    const { runtime, findHivekeeperByEmail, findHivekeeperByEmailLocalPart, findAgentByName } =
      makeRuntime();
    const id = await resolveAuditParticipantReference(VALID_UUID, 'actor-id', runtime);
    expect(id).toBe(VALID_UUID);
    expect(findHivekeeperByEmail).not.toHaveBeenCalled();
    expect(findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
    expect(findAgentByName).not.toHaveBeenCalled();
  });

  it('UUID v7 in uppercase is normalised to lowercase', async () => {
    const { runtime } = makeRuntime();
    const id = await resolveAuditParticipantReference(
      VALID_UUID.toUpperCase(),
      'subject-id',
      runtime,
    );
    expect(id).toBe(VALID_UUID);
  });

  it('hivekeeper email resolves via findHivekeeperByEmail', async () => {
    const findHivekeeperByEmail = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const { runtime } = makeRuntime({ findHivekeeperByEmail });
    const id = await resolveAuditParticipantReference('admin@example.com', 'actor-id', runtime);
    expect(id).toBe(OWNER_UUID);
    expect(findHivekeeperByEmail).toHaveBeenCalledWith(HIVE_ID, 'admin@example.com');
  });

  it('agent reference resolves via owner local-part + agent name lookup', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi.fn().mockResolvedValue(makeAgent(AGENT_UUID, OWNER_UUID));
    const { runtime } = makeRuntime({ findHivekeeperByEmailLocalPart, findAgentByName });

    const id = await resolveAuditParticipantReference(
      `worker-a@admin.${HIVE_NAME}`,
      'subject-id',
      runtime,
    );

    expect(id).toBe(AGENT_UUID);
    expect(findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(HIVE_ID, 'admin');
    expect(findAgentByName).toHaveBeenCalledWith(HIVE_ID, OWNER_UUID, 'worker-a');
  });

  it('garbage input throws CliError(CONFIG_INVALID, actor_id_unparseable) for actor-id', async () => {
    const { runtime } = makeRuntime();
    await expect(
      resolveAuditParticipantReference('garbage', 'actor-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('actor_id_unparseable');
      expect(e.message).toContain('--actor-id');
      return true;
    });
  });

  it('garbage input throws CliError(CONFIG_INVALID, subject_id_unparseable) for subject-id', async () => {
    const { runtime } = makeRuntime();
    await expect(
      resolveAuditParticipantReference('garbage', 'subject-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('subject_id_unparseable');
      expect(e.message).toContain('--subject-id');
      return true;
    });
  });

  it('"self" alias throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    await expect(resolveAuditParticipantReference('self', 'actor-id', runtime)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(CliError);
        const e = err as CliError;
        expect(e.code).toBe('CONFIG_INVALID');
        expect(e.subCode).toBe('kind_not_allowed');
        return true;
      },
    );
  });

  it('credential-active alias (`<ref>:latest`) throws CliError(CONFIG_INVALID, kind_not_allowed)', async () => {
    const { runtime } = makeRuntime();
    // audit subjects/actors are participant ids, not credential JTIs.
    await expect(
      resolveAuditParticipantReference('admin@example.com:latest', 'subject-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.subCode).toBe('kind_not_allowed');
      return true;
    });
  });

  it('email not found throws AuthError(PARTICIPANT_NOT_FOUND, audit_actor_email_not_found)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      resolveAuditParticipantReference('ghost@example.com', 'actor-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthError);
      const e = err as AuthError;
      expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
      expect(e.subCode).toBe('audit_actor_email_not_found');
      return true;
    });
  });

  it('email not found via subject-id flag uses audit_subject_email_not_found subCode', async () => {
    const { runtime } = makeRuntime();
    await expect(
      resolveAuditParticipantReference('ghost@example.com', 'subject-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as AuthError;
      expect(e.subCode).toBe('audit_subject_email_not_found');
      return true;
    });
  });

  it('agent owner not found throws AuthError(PARTICIPANT_NOT_FOUND, audit_<flag>_owner_not_found)', async () => {
    const { runtime, findAgentByName } = makeRuntime();
    await expect(
      resolveAuditParticipantReference(`worker-a@ghost.${HIVE_NAME}`, 'actor-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthError);
      const e = err as AuthError;
      expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
      expect(e.subCode).toBe('audit_actor_owner_not_found');
      return true;
    });
    expect(findAgentByName).not.toHaveBeenCalled();
  });

  it('agent name not found under owner throws AuthError(PARTICIPANT_NOT_FOUND, audit_<flag>_name_not_found)', async () => {
    const findHivekeeperByEmailLocalPart = vi.fn().mockResolvedValue(makeHivekeeper(OWNER_UUID));
    const findAgentByName = vi.fn().mockResolvedValue(null);
    const { runtime } = makeRuntime({ findHivekeeperByEmailLocalPart, findAgentByName });

    await expect(
      resolveAuditParticipantReference(`ghost@admin.${HIVE_NAME}`, 'subject-id', runtime),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthError);
      const e = err as AuthError;
      expect(e.code).toBe('PARTICIPANT_NOT_FOUND');
      expect(e.subCode).toBe('audit_subject_name_not_found');
      return true;
    });
  });
});
