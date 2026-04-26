import { describe, expect, it } from 'vitest';

import type { IdentityContext } from '#domain/auth/types.js';

import { classifyRecipient, lookup, MATRIX_ROWS, senderClass } from './matrix.js';
import type { RecipientClass, ResolvedRecipient, SenderClass } from './types.js';

const SENDER_CLASSES: readonly SenderClass[] = ['hivekeeper', 'worker', 'scout'];
const RECIPIENT_CLASSES: readonly RecipientClass[] = [
  'own_worker',
  'own_scout',
  'other_owner_worker',
  'other_owner_scout',
  'own_hivekeeper',
  'other_hivekeeper',
  'self',
];

const HIVE_ID = 'hive-1';
const COLONY_ID = 'colony-1';
const KEEPER_A = 'keeper-a';
const KEEPER_B = 'keeper-b';
const WORKER_A = 'worker-a';
const SCOUT_A = 'scout-a';
const WORKER_B = 'worker-b';

function fakeContext(
  kind: 'hivekeeper' | 'worker' | 'scout',
  participantId: string,
  ownerId?: string,
): IdentityContext {
  const baseSnapshot = {
    issuedAt: new Date('2026-04-26T00:00:00.000Z'),
    credentialJti: 'jti-1',
    credentialKid: 'kid-1',
  };
  const liveType = kind === 'hivekeeper' ? undefined : kind;
  return {
    participantId,
    kind,
    hiveId: HIVE_ID,
    colonyId: COLONY_ID,
    ownerId,
    snapshot: baseSnapshot,
    current: liveType === undefined ? { state: 'active' } : { state: 'active', type: liveType },
  } as IdentityContext;
}

describe('matrix table — coverage', () => {
  it('has 20 explicit rows (1-13 from worker/hivekeeper rows + 14, 14b, 15-18 scout rows + 19 scout-self)', () => {
    // Tech spec table enumerates rows 1-19 with the inserted 14b — 20 explicit
    // entries total. The "18 + 14b + default deny" framing in the spec prose
    // refers to the standard product matrix (1-18) plus the Scout-cross-owner
    // augmentation (14b) plus the default-deny fall-through; the Scout/self
    // row (19) is also explicit. Self rows: rows 6, 13, 19.
    expect(MATRIX_ROWS).toHaveLength(20);
  });

  it('every (sender, recipient) combination resolves to a row (no undefined)', () => {
    for (const s of SENDER_CLASSES) {
      for (const r of RECIPIENT_CLASSES) {
        const row = lookup(s, r);
        expect(row.decision).toMatch(/allow|deny/);
      }
    }
  });

  it('all explicit deny rows carry a non-allow reason', () => {
    for (const row of MATRIX_ROWS) {
      if (row.decision === 'deny') expect(row.reason).not.toBe('allow');
      else expect(row.reason).toBe('allow');
    }
  });

  it('every sender → self is allow', () => {
    for (const s of SENDER_CLASSES) {
      expect(lookup(s, 'self').decision).toBe('allow');
    }
  });
});

describe('matrix table — explicit deny rows from product spec', () => {
  const cases: ReadonlyArray<{ sender: SenderClass; recipient: RecipientClass; reason: string }> = [
    {
      sender: 'hivekeeper',
      recipient: 'other_owner_worker',
      reason: 'hivekeeper_to_other_owner_worker',
    },
    { sender: 'worker', recipient: 'other_owner_worker', reason: 'worker_to_other_owner_worker' },
    { sender: 'worker', recipient: 'other_hivekeeper', reason: 'worker_to_other_hivekeeper' },
    { sender: 'scout', recipient: 'other_owner_worker', reason: 'scout_to_other_owner_worker' },
  ];
  it.each(cases)('$sender → $recipient → deny ($reason)', ({ sender, recipient, reason }) => {
    const row = lookup(sender, recipient);
    expect(row.decision).toBe('deny');
    expect(row.reason).toBe(reason);
  });
});

describe('matrix table — Scout-to-Scout cross owner (row 14b)', () => {
  it('scout → other_owner_scout is allow', () => {
    const row = lookup('scout', 'other_owner_scout');
    expect(row.decision).toBe('allow');
  });
});

describe('senderClass', () => {
  it('returns hivekeeper for hivekeeper kind', () => {
    expect(senderClass(fakeContext('hivekeeper', KEEPER_A))).toBe('hivekeeper');
  });

  it('returns the live type for agents (not the snapshot kind)', () => {
    expect(senderClass(fakeContext('worker', WORKER_A, KEEPER_A))).toBe('worker');
    expect(senderClass(fakeContext('scout', SCOUT_A, KEEPER_A))).toBe('scout');
  });
});

describe('classifyRecipient', () => {
  function recipient(
    id: string,
    kind: 'hivekeeper' | 'worker' | 'scout',
    ownerId?: string,
  ): ResolvedRecipient {
    if (kind === 'hivekeeper') return { id, kind, hiveId: HIVE_ID };
    const r: ResolvedRecipient = { id, kind, type: kind, hiveId: HIVE_ID };
    if (ownerId !== undefined) r.ownerId = ownerId;
    return r;
  }

  it('returns self when sender id equals recipient id', () => {
    const ctx = fakeContext('hivekeeper', KEEPER_A);
    expect(classifyRecipient(ctx, recipient(KEEPER_A, 'hivekeeper'))).toBe('self');
  });

  it('hivekeeper → other hivekeeper', () => {
    const ctx = fakeContext('hivekeeper', KEEPER_A);
    expect(classifyRecipient(ctx, recipient(KEEPER_B, 'hivekeeper'))).toBe('other_hivekeeper');
  });

  it('worker → own_hivekeeper (recipient is the agent owner)', () => {
    const ctx = fakeContext('worker', WORKER_A, KEEPER_A);
    expect(classifyRecipient(ctx, recipient(KEEPER_A, 'hivekeeper'))).toBe('own_hivekeeper');
  });

  it('worker → other_hivekeeper (recipient is a different keeper)', () => {
    const ctx = fakeContext('worker', WORKER_A, KEEPER_A);
    expect(classifyRecipient(ctx, recipient(KEEPER_B, 'hivekeeper'))).toBe('other_hivekeeper');
  });

  it('worker (own) → own_worker / own_scout when same owner', () => {
    const ctx = fakeContext('worker', WORKER_A, KEEPER_A);
    expect(classifyRecipient(ctx, recipient(WORKER_B, 'worker', KEEPER_A))).toBe('own_worker');
    expect(classifyRecipient(ctx, recipient(SCOUT_A, 'scout', KEEPER_A))).toBe('own_scout');
  });

  it('worker → other_owner_worker / other_owner_scout when owners differ', () => {
    const ctx = fakeContext('worker', WORKER_A, KEEPER_A);
    expect(classifyRecipient(ctx, recipient(WORKER_B, 'worker', KEEPER_B))).toBe(
      'other_owner_worker',
    );
    expect(classifyRecipient(ctx, recipient(SCOUT_A, 'scout', KEEPER_B))).toBe('other_owner_scout');
  });

  it('hivekeeper → own_worker when keeper is the agent owner', () => {
    const ctx = fakeContext('hivekeeper', KEEPER_A);
    expect(classifyRecipient(ctx, recipient(WORKER_A, 'worker', KEEPER_A))).toBe('own_worker');
  });

  it('hivekeeper → other_owner_worker when agent is owned by another keeper', () => {
    const ctx = fakeContext('hivekeeper', KEEPER_A);
    expect(classifyRecipient(ctx, recipient(WORKER_B, 'worker', KEEPER_B))).toBe(
      'other_owner_worker',
    );
  });

  it('agent recipient missing ownerId falls back to other_owner_* (most restrictive)', () => {
    const ctx = fakeContext('worker', WORKER_A, KEEPER_A);
    expect(
      classifyRecipient(ctx, { id: WORKER_B, kind: 'worker', type: 'worker', hiveId: HIVE_ID }),
    ).toBe('other_owner_worker');
  });
});
