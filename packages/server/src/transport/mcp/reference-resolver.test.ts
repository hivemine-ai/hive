import { type Mock, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { IdentityContext } from '#domain/auth/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { CellError } from '#domain/cells/index.js';

import {
  createReferenceResolver,
  parseReference,
  type ParsedReference,
} from './reference-resolver.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// MockRepo uses Mock for every function so `expect(fn).toHaveBeenCalled*` does
// not trigger @typescript-eslint/unbound-method (method is typed as Mock, not
// as a plain function extracted from an object).
type MockRepo = {
  [K in keyof ParticipantsReadRepo]: Mock;
};

function makeIdentity(overrides?: Partial<IdentityContext>): IdentityContext {
  return {
    participantId: uuidv7(),
    kind: 'worker',
    hiveId: uuidv7(),
    colonyId: uuidv7(),
    snapshot: {
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      credentialJti: uuidv7(),
      credentialKid: 'kid-001',
    },
    current: { state: 'active' },
    ...overrides,
  };
}

function makeRepo(overrides?: Partial<MockRepo>): MockRepo {
  return {
    findHiveById: vi.fn().mockResolvedValue(null),
    findColonyById: vi.fn().mockResolvedValue(null),
    findHivekeeperById: vi.fn().mockResolvedValue(null),
    findHivekeeperByEmail: vi.fn().mockResolvedValue(null),
    findAgentById: vi.fn().mockResolvedValue(null),
    findAgentByName: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    getParticipantState: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1 — parseReference (pure parser, no async)
// ---------------------------------------------------------------------------

describe('parseReference', () => {
  // UUID v7 — lowercase canonical
  it('returns uuid kind for lowercase UUID v7', () => {
    const id = uuidv7();
    const result = parseReference(id);
    expect(result).toEqual<ParsedReference>({ kind: 'uuid', id });
  });

  // UUID v7 — uppercase input normalised to lowercase
  it('accepts uppercase UUID v7 and normalises output to lowercase', () => {
    const id = uuidv7();
    const upper = id.toUpperCase();
    const result = parseReference(upper);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('uuid');
    if (result!.kind === 'uuid') {
      expect(result!.id).toBe(id.toLowerCase());
    }
  });

  // 'self' alias — case-sensitive (lowercase only)
  it('returns self kind for literal "self"', () => {
    expect(parseReference('self')).toEqual<ParsedReference>({ kind: 'self' });
  });

  it('returns null for "Self" (case-sensitive — only lowercase)', () => {
    expect(parseReference('Self')).toBeNull();
  });

  it('returns null for "SELF" (case-sensitive — only lowercase)', () => {
    expect(parseReference('SELF')).toBeNull();
  });

  // 'self' with surrounding whitespace — trimmed first
  it('trims whitespace before parsing: "  self  " resolves to self kind', () => {
    expect(parseReference('  self  ')).toEqual<ParsedReference>({ kind: 'self' });
  });

  // Hivekeeper email — single @, no trailing .<hive>
  it('returns hivekeeper-email kind for simple email format', () => {
    const result = parseReference('admin@example.com');
    expect(result).toEqual<ParsedReference>({
      kind: 'hivekeeper-email',
      email: 'admin@example.com',
    });
  });

  it('returns hivekeeper-email kind for email with subdomain', () => {
    const result = parseReference('user@mail.example.com');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('hivekeeper-email');
  });

  // Agent reference — double @, with trailing .<hive>
  it('returns agent-reference kind for double-@ format', () => {
    const result = parseReference('worker-a@admin@example.com.my-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'worker-a',
      ownerEmail: 'admin@example.com',
      hiveName: 'my-hive',
    });
  });

  it('returns agent-reference kind when owner email has subdomain', () => {
    // owner email = admin@mail.example.com → domain contains dots;
    // split on LAST dot after second @ for hiveName
    const result = parseReference('scout@admin@mail.example.com.my-hive');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('agent-reference');
    if (result!.kind === 'agent-reference') {
      expect(result!.agentName).toBe('scout');
      expect(result!.ownerEmail).toBe('admin@mail.example.com');
      expect(result!.hiveName).toBe('my-hive');
    }
  });

  // Empty string → null
  it('returns null for empty string', () => {
    expect(parseReference('')).toBeNull();
  });

  // Whitespace only → null (after trim)
  it('returns null for whitespace-only string', () => {
    expect(parseReference('   ')).toBeNull();
  });

  // No @ — not self, not UUID, not email → null
  it('returns null for string with no @ and not self/uuid', () => {
    expect(parseReference('notavalid')).toBeNull();
  });

  // Triple @ → null (ambiguous — per grammar: exactly 2 @ = agent-reference, exactly 1 @ = email)
  it('returns null for triple @ (ambiguous, outside defined grammar)', () => {
    expect(parseReference('a@b@c@d.hive')).toBeNull();
  });

  // Malformed UUID (v4-style) → null
  it('returns null for UUID v4 (version bit 4, not v7)', () => {
    // UUID v4 has version nibble = 4, not 7
    const v4like = '01234567-89ab-4def-89ab-0123456789ab';
    expect(parseReference(v4like)).toBeNull();
  });

  it('returns null for malformed UUID-shaped string missing version 7', () => {
    expect(parseReference('01234567-89ab-6def-89ab-0123456789ab')).toBeNull();
  });

  // Single @ with dotted domain — if exactly one @, routed to hivekeeper-email, not agent-reference
  it('routes single-@ with dotted domain to hivekeeper-email (not agent-reference)', () => {
    const result = parseReference('user@sub.domain.com');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('hivekeeper-email');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — resolveParticipantReference happy paths
// ---------------------------------------------------------------------------

describe('resolveParticipantReference — happy paths', () => {
  it('UUID v7 input passes through lowercased without any repo lookup', async () => {
    const id = uuidv7();
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    const result = await resolver.resolveParticipantReference(id, identity);

    expect(result).toBe(id.toLowerCase());
    expect(repo.findHivekeeperByEmail).not.toHaveBeenCalled();
    expect(repo.findAgentByName).not.toHaveBeenCalled();
    expect(repo.findHiveById).not.toHaveBeenCalled();
  });

  it('uppercase UUID v7 passes through normalised to lowercase without repo lookup', async () => {
    const id = uuidv7();
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    const result = await resolver.resolveParticipantReference(id.toUpperCase(), identity);

    expect(result).toBe(id.toLowerCase());
    expect(repo.findHivekeeperByEmail).not.toHaveBeenCalled();
  });

  it('"self" returns callerContext.participantId without any repo lookup', async () => {
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    const result = await resolver.resolveParticipantReference('self', identity);

    expect(result).toBe(identity.participantId);
    expect(repo.findHivekeeperByEmail).not.toHaveBeenCalled();
    expect(repo.findAgentByName).not.toHaveBeenCalled();
  });

  it('email input resolves to hivekeeper.id when found', async () => {
    const hivekeeper = {
      id: uuidv7(),
      hiveId: uuidv7(),
      colonyId: uuidv7(),
      email: 'keeper@example.com',
      displayName: null,
      isAdmin: false,
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };
    const repo = makeRepo({
      findHivekeeperByEmail: vi.fn().mockResolvedValue(hivekeeper),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    const result = await resolver.resolveParticipantReference('keeper@example.com', identity);

    expect(result).toBe(hivekeeper.id);
    expect(repo.findHivekeeperByEmail).toHaveBeenCalledWith(identity.hiveId, 'keeper@example.com');
  });

  it('agent reference resolves through hive + hivekeeper + agent lookups in order', async () => {
    const hiveId = uuidv7();
    const hiveName = 'my-hive';
    const ownerEmail = 'admin@example.com';
    const agentName = 'worker-a';

    const hive = { id: hiveId, name: hiveName, createdAt: new Date() };
    const hivekeeper = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      email: ownerEmail,
      displayName: null,
      isAdmin: true,
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };
    const agent = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      ownerId: hivekeeper.id,
      name: agentName,
      type: 'worker' as const,
      capabilities: [],
      instructions: '',
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };

    const repo = makeRepo({
      findHiveById: vi.fn().mockResolvedValue(hive),
      findHivekeeperByEmail: vi.fn().mockResolvedValue(hivekeeper),
      findAgentByName: vi.fn().mockResolvedValue(agent),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId });

    const ref = `${agentName}@${ownerEmail}.${hiveName}`;
    const result = await resolver.resolveParticipantReference(ref, identity);

    expect(result).toBe(agent.id);
    expect(repo.findHiveById).toHaveBeenCalledWith(hiveId);
    expect(repo.findHivekeeperByEmail).toHaveBeenCalledWith(hiveId, ownerEmail);
    expect(repo.findAgentByName).toHaveBeenCalledWith(hiveId, hivekeeper.id, agentName);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — resolveParticipantReference error paths
// ---------------------------------------------------------------------------

describe('resolveParticipantReference — error paths', () => {
  it('unparseable input throws CellError INVALID_INPUT reference_unparseable', async () => {
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    await expect(
      resolver.resolveParticipantReference('not-a-valid-ref!', identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.subCode).toBe('reference_unparseable');
      return true;
    });
  });

  it('empty string throws CellError INVALID_INPUT reference_unparseable', async () => {
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    await expect(resolver.resolveParticipantReference('', identity)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(CellError);
        const e = err as CellError;
        expect(e.code).toBe('INVALID_INPUT');
        expect(e.subCode).toBe('reference_unparseable');
        return true;
      },
    );
  });

  it('email parses but hivekeeper not found throws RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const repo = makeRepo({ findHivekeeperByEmail: vi.fn().mockResolvedValue(null) });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    await expect(
      resolver.resolveParticipantReference('nobody@example.com', identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });

  it('agent reference with mismatched hive name throws RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const hiveId = uuidv7();
    // Hive found but its name does NOT match the hive-name in the reference
    const hive = { id: hiveId, name: 'actual-hive', createdAt: new Date() };

    const repo = makeRepo({ findHiveById: vi.fn().mockResolvedValue(hive) });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId });

    // Reference claims hive-name = 'wrong-hive', but the hive's actual name is 'actual-hive'
    await expect(
      resolver.resolveParticipantReference('agent@owner@example.com.wrong-hive', identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });

  it('agent reference: hive matches, owner not found → RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const hiveId = uuidv7();
    const hiveName = 'my-hive';
    const hive = { id: hiveId, name: hiveName, createdAt: new Date() };

    const repo = makeRepo({
      findHiveById: vi.fn().mockResolvedValue(hive),
      findHivekeeperByEmail: vi.fn().mockResolvedValue(null),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId });

    await expect(
      resolver.resolveParticipantReference(`worker@nobody@example.com.${hiveName}`, identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });

  it('agent reference: hive and owner found but agent not found → RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const hiveId = uuidv7();
    const hiveName = 'my-hive';
    const hive = { id: hiveId, name: hiveName, createdAt: new Date() };
    const hivekeeper = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      email: 'admin@example.com',
      displayName: null,
      isAdmin: true,
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };

    const repo = makeRepo({
      findHiveById: vi.fn().mockResolvedValue(hive),
      findHivekeeperByEmail: vi.fn().mockResolvedValue(hivekeeper),
      findAgentByName: vi.fn().mockResolvedValue(null),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId });

    await expect(
      resolver.resolveParticipantReference(`ghost-agent@admin@example.com.${hiveName}`, identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });
});
