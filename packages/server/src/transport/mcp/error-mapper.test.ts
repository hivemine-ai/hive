import { ZodError, z } from 'zod';
import { describe, expect, it } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import { CellError } from '#domain/cells/index.js';
import { WaggleError } from '#domain/notifications/index.js';

import {
  MCP_ERR_FORBIDDEN,
  MCP_ERR_INTERNAL,
  MCP_ERR_INVALID_PARAMS,
  MCP_ERR_RECIPIENT_UNREACHABLE,
  MCP_ERR_UNAUTHORIZED,
} from './error-codes.js';
import { SessionError, mapDomainError } from './error-mapper.js';

// ---------------------------------------------------------------------------
// Group 1 — AuthError codes that fold into -32001 UNAUTHORIZED
// ---------------------------------------------------------------------------

describe('mapDomainError — AuthError unauthorized codes', () => {
  const cases: Array<[ConstructorParameters<typeof AuthError>[0], string]> = [
    ['CREDENTIAL_MISSING', 'authentication required'],
    ['CREDENTIAL_INAUTHENTIC', 'authentication failed'],
    ['CREDENTIAL_EXPIRED', 'authentication failed'],
    ['CREDENTIAL_NOT_YET_VALID', 'authentication failed'],
    ['CREDENTIAL_REVOKED', 'authentication failed'],
    ['PARTICIPANT_NOT_FOUND', 'authentication failed'],
    ['PARTICIPANT_NOT_ACTIVE', 'authentication failed'],
  ];

  for (const [code, expectedMessage] of cases) {
    it(`maps AuthError(${code}) → wire.code ${MCP_ERR_UNAUTHORIZED}, message "${expectedMessage}"`, () => {
      const result = mapDomainError(new AuthError(code));
      expect(result.wire.code).toBe(MCP_ERR_UNAUTHORIZED);
      expect(result.wire.message).toBe(expectedMessage);
      expect(result.domainCode).toBe(code);
      expect(result.subCode).toBeNull();
    });
  }

  it('preserves AuthError subCode in MappedError.subCode but NOT in wire.message', () => {
    const subCode = 'signature';
    const err = new AuthError('CREDENTIAL_INAUTHENTIC', { subCode });
    const result = mapDomainError(err);
    expect(result.subCode).toBe(subCode);
    expect(result.wire.message).not.toContain(subCode);
  });

  it('preserves kid_unknown subCode in MappedError.subCode but NOT in wire.message', () => {
    const subCode = 'kid_unknown';
    const err = new AuthError('CREDENTIAL_INAUTHENTIC', { subCode });
    const result = mapDomainError(err);
    expect(result.subCode).toBe(subCode);
    expect(result.wire.message).not.toContain(subCode);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — AuthError INSUFFICIENT_PRIVILEGE → -32002 FORBIDDEN
// ---------------------------------------------------------------------------

describe('mapDomainError — AuthError INSUFFICIENT_PRIVILEGE', () => {
  it('maps to wire.code FORBIDDEN and message "forbidden"', () => {
    const result = mapDomainError(new AuthError('INSUFFICIENT_PRIVILEGE'));
    expect(result.wire.code).toBe(MCP_ERR_FORBIDDEN);
    expect(result.wire.message).toBe('forbidden');
    expect(result.domainCode).toBe('INSUFFICIENT_PRIVILEGE');
    expect(result.subCode).toBeNull();
  });

  it('preserves subCode in MappedError.subCode but NOT in wire.message', () => {
    const subCode = 'not_admin';
    const err = new AuthError('INSUFFICIENT_PRIVILEGE', { subCode });
    const result = mapDomainError(err);
    expect(result.subCode).toBe(subCode);
    expect(result.wire.message).not.toContain(subCode);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Admin-only AuthError codes that should never reach MCP
//            Defense-in-depth: map to -32603 INTERNAL
// ---------------------------------------------------------------------------

describe('mapDomainError — admin-only AuthError codes (defense-in-depth)', () => {
  const adminOnlyCodes: Array<ConstructorParameters<typeof AuthError>[0]> = [
    'CREDENTIAL_ALREADY_REVOKED',
    'PARTICIPANT_NOT_FOUND_FOR_ISSUE',
    'LAST_ADMIN_INVARIANT',
    'INVALID_STATE_TRANSITION',
    'HIVE_ALREADY_INITIALIZED',
  ];

  for (const code of adminOnlyCodes) {
    it(`maps AuthError(${code}) → wire.code INTERNAL, message "internal error"`, () => {
      const result = mapDomainError(new AuthError(code));
      expect(result.wire.code).toBe(MCP_ERR_INTERNAL);
      expect(result.wire.message).toBe('internal error');
    });
  }
});

// ---------------------------------------------------------------------------
// Group 4 — CellError mapping
// ---------------------------------------------------------------------------

describe('mapDomainError — CellError', () => {
  it('maps RECIPIENT_UNREACHABLE → -32004, message "recipient is not reachable"', () => {
    const result = mapDomainError(new CellError('RECIPIENT_UNREACHABLE'));
    expect(result.wire.code).toBe(MCP_ERR_RECIPIENT_UNREACHABLE);
    expect(result.wire.message).toBe('recipient is not reachable');
    expect(result.domainCode).toBe('RECIPIENT_UNREACHABLE');
    expect(result.subCode).toBeNull();
  });

  it('RECIPIENT_UNREACHABLE: wire.message does NOT leak subCode cell_closed_or_missing', () => {
    const result = mapDomainError(
      new CellError('RECIPIENT_UNREACHABLE', { subCode: 'cell_closed_or_missing' }),
    );
    expect(result.wire.message).not.toContain('cell_closed_or_missing');
    expect(result.subCode).toBe('cell_closed_or_missing');
  });

  it('RECIPIENT_UNREACHABLE: wire.message does NOT leak subCode visibility_denied', () => {
    const result = mapDomainError(
      new CellError('RECIPIENT_UNREACHABLE', { subCode: 'visibility_denied' }),
    );
    expect(result.wire.message).not.toContain('visibility_denied');
    expect(result.subCode).toBe('visibility_denied');
  });

  it('maps INVALID_INPUT → -32602, message "invalid input"', () => {
    const result = mapDomainError(new CellError('INVALID_INPUT'));
    expect(result.wire.code).toBe(MCP_ERR_INVALID_PARAMS);
    expect(result.wire.message).toBe('invalid input');
    expect(result.domainCode).toBe('INVALID_INPUT');
  });

  it('maps INSUFFICIENT_PRIVILEGE → -32002, message "forbidden"', () => {
    const result = mapDomainError(new CellError('INSUFFICIENT_PRIVILEGE'));
    expect(result.wire.code).toBe(MCP_ERR_FORBIDDEN);
    expect(result.wire.message).toBe('forbidden');
    expect(result.domainCode).toBe('INSUFFICIENT_PRIVILEGE');
  });

  it('maps INTERNAL_INCONSISTENCY → -32603, message "internal error"', () => {
    const result = mapDomainError(new CellError('INTERNAL_INCONSISTENCY'));
    expect(result.wire.code).toBe(MCP_ERR_INTERNAL);
    expect(result.wire.message).toBe('internal error');
    expect(result.domainCode).toBe('INTERNAL_INCONSISTENCY');
  });
});

// ---------------------------------------------------------------------------
// Group 5 — WaggleError mapping
// ---------------------------------------------------------------------------

describe('mapDomainError — WaggleError', () => {
  it('maps PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE → -32001, message "authentication failed"', () => {
    const result = mapDomainError(new WaggleError('PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE'));
    expect(result.wire.code).toBe(MCP_ERR_UNAUTHORIZED);
    expect(result.wire.message).toBe('authentication failed');
    expect(result.domainCode).toBe('PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE');
    expect(result.subCode).toBeNull();
  });

  it('maps WaggleError INVALID_INPUT → -32602, message "invalid input"', () => {
    const result = mapDomainError(new WaggleError('INVALID_INPUT'));
    expect(result.wire.code).toBe(MCP_ERR_INVALID_PARAMS);
    expect(result.wire.message).toBe('invalid input');
    expect(result.domainCode).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Group 6 — SessionError (transport-local synthetic codes)
// ---------------------------------------------------------------------------

describe('mapDomainError — SessionError', () => {
  it('maps SESSION_NOT_FOUND → -32001, message "authentication required"', () => {
    const result = mapDomainError(new SessionError('SESSION_NOT_FOUND'));
    expect(result.wire.code).toBe(MCP_ERR_UNAUTHORIZED);
    expect(result.wire.message).toBe('authentication required');
    expect(result.domainCode).toBe('SESSION_NOT_FOUND');
    expect(result.subCode).toBeNull();
  });

  it('maps SESSION_INVALIDATED → -32001, message "authentication required"', () => {
    const result = mapDomainError(new SessionError('SESSION_INVALIDATED'));
    expect(result.wire.code).toBe(MCP_ERR_UNAUTHORIZED);
    expect(result.wire.message).toBe('authentication required');
    expect(result.domainCode).toBe('SESSION_INVALIDATED');
    expect(result.subCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 7 — ZodError → INVALID_INPUT
// ---------------------------------------------------------------------------

describe('mapDomainError — ZodError', () => {
  function captureZodError(): ZodError {
    const schema = z.object({ x: z.number() });
    try {
      schema.parse({ x: 'nope' });
    } catch (err) {
      if (err instanceof ZodError) return err;
    }
    throw new Error('Expected ZodError to be thrown');
  }

  it('maps ZodError → -32602, message "invalid input"', () => {
    const zodErr = captureZodError();
    const result = mapDomainError(zodErr);
    expect(result.wire.code).toBe(MCP_ERR_INVALID_PARAMS);
    expect(result.wire.message).toBe('invalid input');
  });

  it('preserves first issue code in subCode for log forensics', () => {
    const zodErr = captureZodError();
    const result = mapDomainError(zodErr);
    expect(result.subCode).toBe(zodErr.issues[0]?.code ?? null);
  });

  it('sets domainCode to INVALID_INPUT for log alignment', () => {
    const zodErr = captureZodError();
    const result = mapDomainError(zodErr);
    expect(result.domainCode).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Group 9 — ZodError wire.data field (PRY-023 fix)
// Per JSON-RPC 2.0 spec, the `data` field of an error response carries
// structured method-specific info. We populate it with sanitized zod issues so
// clients can identify which field violated which rule without trial-and-error
// re-submission. F-S2 invariant preserved: wire.message stays the string-literal
// "invalid input"; data is additive. Privacy invariant: sanitize whitelists only
// {path, code, message} — `received` (the value the caller sent) NEVER echoed.
// ---------------------------------------------------------------------------

describe('mapDomainError — ZodError wire.data (PRY-023)', () => {
  it('AC1 — schema violation populates wire.data with issues array', () => {
    const schema = z.object({ body: z.string().min(1) });
    let captured: ZodError | undefined;
    try {
      schema.parse({ body: '' });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);

    expect(result.wire.data).toBeDefined();
    const data = result.wire.data as {
      issues: Array<{ path: string; code: string; message: string }>;
    };
    expect(Array.isArray(data.issues)).toBe(true);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues[0]?.path).toBe('body');
    expect(typeof data.issues[0]?.code).toBe('string');
    expect(typeof data.issues[0]?.message).toBe('string');
    // F-S2 invariant: message string-literal preserved.
    expect(result.wire.message).toBe('invalid input');
  });

  it('AC2 — nested path joined with dots', () => {
    const schema = z.object({ recipient: z.object({ email: z.string().email() }) });
    let captured: ZodError | undefined;
    try {
      schema.parse({ recipient: { email: 'not-an-email' } });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);
    const data = result.wire.data as { issues: Array<{ path: string }> };
    expect(data.issues[0]?.path).toBe('recipient.email');
  });

  it('AC2b — array index path joined with dots (e.g. "message_ids.3")', () => {
    const schema = z.object({ message_ids: z.array(z.string().uuid()) });
    let captured: ZodError | undefined;
    try {
      schema.parse({
        message_ids: [
          '00000000-0000-7000-8000-000000000000',
          '00000000-0000-7000-8000-000000000001',
          '00000000-0000-7000-8000-000000000002',
          'not-a-uuid',
        ],
      });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);
    const data = result.wire.data as { issues: Array<{ path: string }> };
    expect(data.issues[0]?.path).toBe('message_ids.3');
  });

  it('AC3 — multiple issues all included in data.issues array', () => {
    const schema = z.object({ body: z.string().min(1), recipient: z.string().min(1) });
    let captured: ZodError | undefined;
    try {
      schema.parse({ body: '', recipient: '' });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);
    const data = result.wire.data as { issues: Array<{ path: string }> };
    expect(data.issues.length).toBe(2);
    const paths = data.issues.map((i) => i.path).sort();
    expect(paths).toEqual(['body', 'recipient']);
  });

  it('AC4 — domain INVALID_INPUT (CellError) does NOT populate wire.data (F-S2 invariant)', () => {
    const cellErr = new CellError('INVALID_INPUT', { subCode: 'message_ids_too_many' });
    const result = mapDomainError(cellErr);
    expect(result.wire.data).toBeUndefined();
    // subCode preserved in MappedError for logs only.
    expect(result.subCode).toBe('message_ids_too_many');
  });

  it('AC4b — domain INVALID_INPUT (WaggleError) does NOT populate wire.data', () => {
    const waggleErr = new WaggleError('INVALID_INPUT', { subCode: 'limit_not_positive' });
    const result = mapDomainError(waggleErr);
    expect(result.wire.data).toBeUndefined();
    expect(result.subCode).toBe('limit_not_positive');
  });

  it('AC5 — wire.data NEVER echoes `received` from zod issues (privacy invariant)', () => {
    const schema = z.object({ secret: z.literal('expected') });
    let captured: ZodError | undefined;
    try {
      schema.parse({ secret: 'sensitive-pii-value' });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');
    // Sanity: the original issue carries the received value.
    expect(JSON.stringify(captured.issues)).toContain('sensitive-pii-value');

    const result = mapDomainError(captured);
    expect(JSON.stringify(result.wire.data)).not.toContain('sensitive-pii-value');
    expect(JSON.stringify(result.wire.data)).not.toContain('received');
  });

  it('AC5b — sanitize whitelists ONLY {path, code, message} keys', () => {
    const schema = z.object({ x: z.number() });
    let captured: ZodError | undefined;
    try {
      schema.parse({ x: 'nope' });
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);
    const data = result.wire.data as { issues: Array<Record<string, unknown>> };
    for (const issue of data.issues) {
      const keys = Object.keys(issue).sort();
      expect(keys).toEqual(['code', 'message', 'path']);
    }
  });

  it('AC6 — non-Zod errors (AuthError, plain Error) leave wire.data undefined (backward compat)', () => {
    const authResult = mapDomainError(new AuthError('CREDENTIAL_MISSING'));
    expect(authResult.wire.data).toBeUndefined();

    const plainResult = mapDomainError(new Error('boom'));
    expect(plainResult.wire.data).toBeUndefined();
  });

  it('issue with empty path array → path string ""', () => {
    // Zod root-level error: e.g. parsing a non-object against z.object()
    const schema = z.object({ x: z.number() });
    let captured: ZodError | undefined;
    try {
      schema.parse('not-an-object');
    } catch (err) {
      if (err instanceof ZodError) captured = err;
    }
    if (!captured) throw new Error('Expected ZodError');

    const result = mapDomainError(captured);
    const data = result.wire.data as { issues: Array<{ path: string }> };
    expect(data.issues[0]?.path).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Group 8 — Unknown Error → INTERNAL
// ---------------------------------------------------------------------------

describe('mapDomainError — unknown error (defense-in-depth)', () => {
  const expectInternal = (result: ReturnType<typeof mapDomainError>) => {
    expect(result.wire.code).toBe(MCP_ERR_INTERNAL);
    expect(result.wire.message).toBe('internal error');
    expect(result.domainCode).toBeNull();
    expect(result.subCode).toBeNull();
  };

  it('maps plain Error to INTERNAL', () => {
    expectInternal(mapDomainError(new Error('boom')));
  });

  it('maps string throw to INTERNAL', () => {
    expectInternal(mapDomainError('not even an error'));
  });

  it('maps null to INTERNAL', () => {
    expectInternal(mapDomainError(null));
  });

  it('maps undefined to INTERNAL', () => {
    expectInternal(mapDomainError(undefined));
  });
});
