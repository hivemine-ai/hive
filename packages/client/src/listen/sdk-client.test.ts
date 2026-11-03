import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { toListenError } from './sdk-client.js';

const httpError = (status: number) =>
  new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, `HTTP ${String(status)}`, {
    status,
    statusText: 'x',
    text: '',
  });

describe('toListenError', () => {
  it('maps a 401 to a rejected credential', () => {
    expect(toListenError(httpError(401)).kind).toBe('auth_rejected');
  });

  it('does not blame the credential for a 403: only the Origin/Host guard sends it', () => {
    const err = toListenError(httpError(403));
    expect(err.kind).toBe('transport');
    expect(err.message).toContain('HIVE_MCP_ALLOWED_HOSTS');
    expect(err.message).toContain('HIVE_MCP_ALLOWED_ORIGINS');
  });
});
