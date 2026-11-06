import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { toSessionFailure } from './upstream.js';

describe('toSessionFailure', () => {
  it.each([
    [-32001, 'auth_rejected'],
    [-32006, 'forbidden'],
    [-32007, 'name_in_use'],
    [-32008, 'name_taken'],
    [-32009, 'agent_suspended'],
    [-32010, 'enrollment_quota_exceeded'],
    [-32011, 'rate_limited'],
    [-32022, 'protocol_unsupported'],
    [-32602, 'invalid_input'],
    [-32603, 'upstream_error'],
  ])('maps JSON-RPC %i to %s and keeps the code', (code, expected) => {
    expect(toSessionFailure(new ProtocolError(code, 'm'))).toEqual({
      code: expected,
      message: 'm',
      rpcCode: code,
    });
  });

  it('tells a server without 2026-07-28 apart from an unreachable one', () => {
    expect(
      toSessionFailure(
        new SdkError(
          SdkErrorCode.EraNegotiationFailed,
          'Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover',
        ),
      ).code,
    ).toBe('protocol_unsupported');
    expect(
      toSessionFailure(
        new SdkError(
          SdkErrorCode.EraNegotiationFailed,
          'Version negotiation probe failed: fetch failed',
        ),
      ).code,
    ).toBe('transport');
    expect(toSessionFailure(new Error('socket hang up')).code).toBe('transport');
  });
});
