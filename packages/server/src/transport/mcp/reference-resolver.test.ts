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
    hiveName: 'test-hive',
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
    findHivekeeperByEmailLocalPart: vi.fn().mockResolvedValue(null),
    findAgentById: vi.fn().mockResolvedValue(null),
    findAgentByName: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    getParticipantState: vi.fn().mockResolvedValue(null),
    listAgents: vi.fn().mockResolvedValue({ agents: [], nextCursor: null }),
    updateAgentLastConnectedAt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1 — parseReference (pure, takes hiveName for suffix disambiguation)
//
// Per ADR-015 § Decision (8-step algorithm):
//   1. UUID v7      → kind: 'uuid'
//   2. 'self'       → kind: 'self'
//   3. count('@') != 1 → null
//   4. split [local, afterAt]
//   5. hiveSuffix = '.' + hiveName
//   6. afterAt endsWith hiveSuffix AND ownerLocal != '' AND EMAIL_LOCAL_PART_RE
//                                                  → kind: 'agent-reference'
//   7. else if EMAIL_RE.test(input) → kind: 'hivekeeper-email'
//   8. else                          → null
// ---------------------------------------------------------------------------

describe('parseReference', () => {
  // --- UUID v7 ---

  it('returns uuid kind for lowercase UUID v7', () => {
    const id = uuidv7();
    expect(parseReference(id, 'test-hive')).toEqual<ParsedReference>({ kind: 'uuid', id });
  });

  it('accepts uppercase UUID v7 and normalises output to lowercase', () => {
    const id = uuidv7();
    const result = parseReference(id.toUpperCase(), 'test-hive');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('uuid');
    if (result!.kind === 'uuid') {
      expect(result!.id).toBe(id.toLowerCase());
    }
  });

  it('returns null for UUID v4 (version bit 4, not v7)', () => {
    expect(parseReference('01234567-89ab-4def-89ab-0123456789ab', 'test-hive')).toBeNull();
  });

  // --- self alias ---

  it('returns self kind for literal "self"', () => {
    expect(parseReference('self', 'test-hive')).toEqual<ParsedReference>({ kind: 'self' });
  });

  it('returns null for "Self" (case-sensitive — only lowercase)', () => {
    expect(parseReference('Self', 'test-hive')).toBeNull();
  });

  it('trims surrounding whitespace before parsing: "  self  " resolves to self kind', () => {
    expect(parseReference('  self  ', 'test-hive')).toEqual<ParsedReference>({ kind: 'self' });
  });

  // --- count('@') != 1 ---

  it('returns null when count(@) == 0 (and not self/uuid)', () => {
    expect(parseReference('not-a-valid-ref', 'test-hive')).toBeNull();
  });

  it('returns null when count(@) > 1 (e.g. legacy double-@ format is rejected)', () => {
    expect(parseReference('agent@owner@example.com.test-hive', 'test-hive')).toBeNull();
  });

  it('returns null when count(@) > 1 — three @s', () => {
    expect(parseReference('a@b@c@d.test-hive', 'test-hive')).toBeNull();
  });

  // --- agent-reference (single @, suffix matches `.<hiveName>`) ---

  it('returns agent-reference for `<agent>@<owner-local>.<hive-name>`', () => {
    const result = parseReference('worker-a@admin.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'worker-a',
      ownerLocal: 'admin',
    });
  });

  it('returns agent-reference when owner-local contains dots (john.doe)', () => {
    const result = parseReference('worker@john.doe.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'worker',
      ownerLocal: 'john.doe',
    });
  });

  it('returns agent-reference when owner-local has dashes/underscores allowed by EMAIL_LOCAL_PART_RE', () => {
    const result = parseReference('w@first-last_x.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'w',
      ownerLocal: 'first-last_x',
    });
  });

  it('returns null when ownerLocal candidate fails EMAIL_LOCAL_PART_RE (whitespace inside)', () => {
    // After suffix strip, ownerLocal = 'admin x' — fails the regex.
    // count('@') == 1, suffix matches, but the pre-suffix portion is invalid →
    // step 6 fails, step 7 also fails (input has space → not email-shaped) → null.
    expect(parseReference('worker@admin x.test-hive', 'test-hive')).toBeNull();
  });

  it('agent-reference takes precedence over hivekeeper-email when suffix matches', () => {
    // Without the suffix check, `worker@admin.test-hive` could also be parsed
    // as a hivekeeper email. ADR-015 step 6 happens before step 7.
    const result = parseReference('worker@admin.test-hive', 'test-hive');
    expect(result?.kind).toBe('agent-reference');
  });

  // --- hivekeeper-email (single @, suffix does NOT match) ---

  it('returns hivekeeper-email when suffix does NOT match the caller hiveName', () => {
    const result = parseReference('admin@example.com', 'cotalker');
    expect(result).toEqual<ParsedReference>({
      kind: 'hivekeeper-email',
      email: 'admin@example.com',
    });
  });

  it('returns hivekeeper-email when suffix matches but ownerLocal would be empty (afterAt == hiveSuffix)', () => {
    // input = 'admin@.cotalker' → afterAt = '.cotalker', hiveSuffix = '.cotalker',
    // ownerLocal = '' → step 6 fails, step 7 evaluates: EMAIL_RE accepts 'admin@.cotalker'
    // (lenient `[^@\s]+@[^@\s]+`), so this resolves as an email of last resort.
    const result = parseReference('admin@.cotalker', 'cotalker');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  it('returns hivekeeper-email when domain happens to look like a longer suffix', () => {
    // hiveName = 'cotalker', input domain = 'cotalker.example.com'
    // hiveSuffix = '.cotalker' — afterAt 'cotalker.example.com' does NOT end with '.cotalker'
    const result = parseReference('admin@cotalker.example.com', 'cotalker');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  // --- empty / whitespace ---

  it('returns null for empty string', () => {
    expect(parseReference('', 'test-hive')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseReference('   ', 'test-hive')).toBeNull();
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
    expect(repo.findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
    expect(repo.findAgentByName).not.toHaveBeenCalled();
  });

  it('"self" returns callerContext.participantId without any repo lookup', async () => {
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity();

    const result = await resolver.resolveParticipantReference('self', identity);

    expect(result).toBe(identity.participantId);
    expect(repo.findHivekeeperByEmail).not.toHaveBeenCalled();
    expect(repo.findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
  });

  it('hivekeeper email resolves to hivekeeper.id when found', async () => {
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
    const identity = makeIdentity({ hiveName: 'cotalker' });

    const result = await resolver.resolveParticipantReference('keeper@example.com', identity);

    expect(result).toBe(hivekeeper.id);
    expect(repo.findHivekeeperByEmail).toHaveBeenCalledWith(identity.hiveId, 'keeper@example.com');
    expect(repo.findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
  });

  it('agent reference resolves through findHivekeeperByEmailLocalPart + findAgentByName', async () => {
    const hiveId = uuidv7();
    const hiveName = 'my-hive';

    const hivekeeper = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      email: 'admin@external.com',
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
      name: 'worker-a',
      type: 'worker' as const,
      capabilities: [],
      instructions: '',
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };

    const repo = makeRepo({
      findHivekeeperByEmailLocalPart: vi.fn().mockResolvedValue(hivekeeper),
      findAgentByName: vi.fn().mockResolvedValue(agent),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId, hiveName });

    // AC1 — caso nominal
    const result = await resolver.resolveParticipantReference(
      `worker-a@admin.${hiveName}`,
      identity,
    );

    expect(result).toBe(agent.id);
    expect(repo.findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(hiveId, 'admin');
    expect(repo.findAgentByName).toHaveBeenCalledWith(hiveId, hivekeeper.id, 'worker-a');
    // hive lookup is NOT necessary: the suffix check at parse time already
    // validated the ref belongs to the caller's hive.
    expect(repo.findHiveById).not.toHaveBeenCalled();
  });

  it('AC2 — agent reference with dotted owner-local resolves correctly', async () => {
    const hiveId = uuidv7();
    const hiveName = 'acme';

    const hivekeeper = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      email: 'john.doe@example.com',
      displayName: null,
      isAdmin: false,
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };
    const agent = {
      id: uuidv7(),
      hiveId,
      colonyId: uuidv7(),
      ownerId: hivekeeper.id,
      name: 'worker',
      type: 'worker' as const,
      capabilities: [],
      instructions: '',
      state: 'active' as const,
      createdAt: new Date(),
      revokedAt: null,
    };

    const repo = makeRepo({
      findHivekeeperByEmailLocalPart: vi.fn().mockResolvedValue(hivekeeper),
      findAgentByName: vi.fn().mockResolvedValue(agent),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId, hiveName });

    const result = await resolver.resolveParticipantReference(
      `worker@john.doe.${hiveName}`,
      identity,
    );

    expect(result).toBe(agent.id);
    expect(repo.findHivekeeperByEmailLocalPart).toHaveBeenCalledWith(hiveId, 'john.doe');
  });

  it('AC3 — Hivekeeper email whose domain does NOT end in .<hive-name> resolves as hivekeeper-email', async () => {
    const hivekeeper = {
      id: uuidv7(),
      hiveId: uuidv7(),
      colonyId: uuidv7(),
      email: 'bob@example.com',
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
    const identity = makeIdentity({ hiveName: 'cotalker' });

    const result = await resolver.resolveParticipantReference('bob@example.com', identity);

    expect(result).toBe(hivekeeper.id);
    expect(repo.findHivekeeperByEmail).toHaveBeenCalled();
    expect(repo.findHivekeeperByEmailLocalPart).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — resolveParticipantReference error paths
// ---------------------------------------------------------------------------

describe('resolveParticipantReference — error paths', () => {
  it('AC4 — unparseable input throws CellError INVALID_INPUT reference_unparseable', async () => {
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

  it('AC4 — empty string throws INVALID_INPUT reference_unparseable', async () => {
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

  it('AC4 — count(@) > 1 throws INVALID_INPUT reference_unparseable (legacy double-@ rejected)', async () => {
    const repo = makeRepo();
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveName: 'test-hive' });

    await expect(
      resolver.resolveParticipantReference('agent@owner@example.com.test-hive', identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.subCode).toBe('reference_unparseable');
      return true;
    });
  });

  it('AC5 — hivekeeper email parses but participant not found → RECIPIENT_UNREACHABLE reference_unresolved', async () => {
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

  it('AC5 — agent reference: owner not found by local-part → RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const repo = makeRepo({ findHivekeeperByEmailLocalPart: vi.fn().mockResolvedValue(null) });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveName: 'my-hive' });

    await expect(
      resolver.resolveParticipantReference('worker@nobody.my-hive', identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });

  it('AC5 — agent reference: owner found, agent not found → RECIPIENT_UNREACHABLE reference_unresolved', async () => {
    const hiveId = uuidv7();
    const hiveName = 'my-hive';
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
      findHivekeeperByEmailLocalPart: vi.fn().mockResolvedValue(hivekeeper),
      findAgentByName: vi.fn().mockResolvedValue(null),
    });
    const resolver = createReferenceResolver({ participantsRepo: repo });
    const identity = makeIdentity({ hiveId, hiveName });

    await expect(
      resolver.resolveParticipantReference(`ghost-agent@admin.${hiveName}`, identity),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CellError);
      const e = err as CellError;
      expect(e.code).toBe('RECIPIENT_UNREACHABLE');
      expect(e.subCode).toBe('reference_unresolved');
      return true;
    });
  });
});
