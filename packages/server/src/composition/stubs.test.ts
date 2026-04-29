import { describe, expect, it } from 'vitest';

import type { IdentityContext } from '#domain/auth/types.js';

import { stubVisibilityEngine } from './stubs.js';

const FAKE_CALLER: IdentityContext = {
  participantId: '019dffff-0000-0000-0000-000000000001',
  kind: 'hivekeeper',
  hiveId: '019dffff-0000-0000-0000-000000000002',
  hiveName: 'test-hive',
  colonyId: '019dffff-0000-0000-0000-000000000003',
  snapshot: {
    issuedAt: new Date(),
    credentialJti: '019dffff-0000-0000-0000-000000000004',
    credentialKid: 'kid-test',
  },
  current: { state: 'active', isAdmin: true },
};

describe('stubVisibilityEngine', () => {
  it('canSend returns true regardless of input', async () => {
    const ok = await stubVisibilityEngine.canSend({
      callerContext: FAKE_CALLER,
      recipientId: '019dffff-0000-0000-0000-00000000000a',
    });
    expect(ok).toBe(true);
  });

  it('canSee returns true regardless of input', async () => {
    const ok = await stubVisibilityEngine.canSee({
      callerContext: FAKE_CALLER,
      targetId: '019dffff-0000-0000-0000-00000000000b',
    });
    expect(ok).toBe(true);
  });
});
