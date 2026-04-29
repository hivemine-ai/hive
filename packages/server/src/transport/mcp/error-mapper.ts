import { ZodError, type ZodIssue } from 'zod';

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
import type { MappedError } from './types.js';

// Transport-local error class for session lifecycle failures. Exported so the
// SessionStore can throw it and callers can import from a single module.
export class SessionError extends Error {
  readonly code: 'SESSION_NOT_FOUND' | 'SESSION_INVALIDATED';

  constructor(code: 'SESSION_NOT_FOUND' | 'SESSION_INVALIDATED') {
    super(code);
    this.name = 'SessionError';
    this.code = code;
  }
}

/**
 * Translates any thrown value from domain or transport into a `MappedError`.
 *
 * Wire shape (`.wire`) is what the JSON-RPC response carries — no domain codes,
 * no subCodes. The rich context (`.domainCode`, `.subCode`) is for log forensics
 * only and MUST NOT be forwarded to the client.
 *
 * Source of truth: tech spec § "Mapping de errores".
 */
export function mapDomainError(err: unknown): MappedError {
  if (err instanceof AuthError) {
    if (err.code === 'CREDENTIAL_MISSING') {
      return {
        wire: { code: MCP_ERR_UNAUTHORIZED, message: 'authentication required' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (
      err.code === 'CREDENTIAL_INAUTHENTIC' ||
      err.code === 'CREDENTIAL_EXPIRED' ||
      err.code === 'CREDENTIAL_NOT_YET_VALID' ||
      err.code === 'CREDENTIAL_REVOKED' ||
      err.code === 'PARTICIPANT_NOT_FOUND' ||
      err.code === 'PARTICIPANT_NOT_ACTIVE'
    ) {
      return {
        wire: { code: MCP_ERR_UNAUTHORIZED, message: 'authentication failed' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (err.code === 'INSUFFICIENT_PRIVILEGE') {
      return {
        wire: { code: MCP_ERR_FORBIDDEN, message: 'forbidden' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    // Admin-only codes (CREDENTIAL_ALREADY_REVOKED, PARTICIPANT_NOT_FOUND_FOR_ISSUE,
    // LAST_ADMIN_INVARIANT, INVALID_STATE_TRANSITION, HIVE_ALREADY_INITIALIZED) must
    // never reach MCP-exposed paths — map to INTERNAL as defense-in-depth.
    return {
      wire: { code: MCP_ERR_INTERNAL, message: 'internal error' },
      domainCode: err.code,
      subCode: err.subCode ?? null,
    };
  }

  if (err instanceof CellError) {
    if (err.code === 'RECIPIENT_UNREACHABLE') {
      return {
        wire: { code: MCP_ERR_RECIPIENT_UNREACHABLE, message: 'recipient is not reachable' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (err.code === 'INVALID_INPUT') {
      return {
        wire: { code: MCP_ERR_INVALID_PARAMS, message: 'invalid input' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (err.code === 'INSUFFICIENT_PRIVILEGE') {
      return {
        wire: { code: MCP_ERR_FORBIDDEN, message: 'forbidden' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (err.code === 'INTERNAL_INCONSISTENCY') {
      return {
        wire: { code: MCP_ERR_INTERNAL, message: 'internal error' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }
  }

  if (err instanceof WaggleError) {
    if (err.code === 'PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE') {
      return {
        wire: { code: MCP_ERR_UNAUTHORIZED, message: 'authentication failed' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }

    if (err.code === 'INVALID_INPUT') {
      return {
        wire: { code: MCP_ERR_INVALID_PARAMS, message: 'invalid input' },
        domainCode: err.code,
        subCode: err.subCode ?? null,
      };
    }
  }

  if (err instanceof SessionError) {
    if (err.code === 'SESSION_NOT_FOUND' || err.code === 'SESSION_INVALIDATED') {
      return {
        wire: { code: MCP_ERR_UNAUTHORIZED, message: 'authentication required' },
        domainCode: err.code,
        subCode: null,
      };
    }
  }

  if (err instanceof ZodError) {
    return {
      wire: {
        code: MCP_ERR_INVALID_PARAMS,
        message: 'invalid input',
        data: { issues: err.issues.map(sanitizeZodIssue) },
      },
      domainCode: 'INVALID_INPUT',
      subCode: err.issues[0]?.code ?? null,
    };
  }

  return {
    wire: { code: MCP_ERR_INTERNAL, message: 'internal error' },
    domainCode: null,
    subCode: null,
  };
}

/**
 * Whitelist-based sanitizer for zod issues going to wire.error.data.
 *
 * Only `{path, code, message}` cross the boundary. We deliberately do NOT copy
 * `received` (the caller-provided value) — echoing it back risks PII leakage if
 * the caller sent sensitive input, and risks echo-amplification on logs that
 * persist the wire response. Future zod versions may add fields like
 * `validation` or `option` that could carry context too — the whitelist
 * approach makes us defaultClosed against new fields rather than defaultOpen.
 *
 * The path array is joined with '.' (zod-native, simplest format). Array index
 * paths surface as `"message_ids.3"`; root-level errors as the empty string.
 */
function sanitizeZodIssue(issue: ZodIssue): { path: string; code: string; message: string } {
  return {
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  };
}
