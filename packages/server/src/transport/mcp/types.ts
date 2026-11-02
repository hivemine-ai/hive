import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';

import type { McpErrorCode } from './error-codes.js';

/**
 * Wrapper passed to tool handlers. Combines the identity (from auth-binding)
 * with per-request data (requestId for correlation). It comes from the authInfo of the
 * request in progress, never from state shared between requests.
 *
 * `IdentityContext` from Auth + Identity does NOT carry `requestId` — this is
 * the transport-only wrapper documented in the tech spec § auth-binding.ts.
 */
export interface RequestContext {
  identity: IdentityContext;
  requestId: UUIDv7;
}

/**
 * Wire-shape of an error that leaves the MCP boundary. The semantic `code`
 * (e.g. RECIPIENT_UNREACHABLE) and `subCode` NEVER cross this boundary — the
 * mapper preserves them only in the structured log for forensics.
 *
 * `data` is the JSON-RPC 2.0 standard structured-info slot (opaque-to-spec,
 * defined-per-method). Populated by the ZodError branch with sanitized issues
 * `{path, code, message}` so clients can identify which input field violated
 * which rule, and by SENDER_QUOTA_EXCEEDED with `{limit, current}`, which describes
 * the quota of the caller itself. Two invariants enforced by the mapper:
 *
 *   - F-S2 invariant (PRY-006): `message` stays a string-literal from the
 *     mapping table; we never interpolate domain `subCode`s into it. Domain
 *     `INVALID_INPUT` paths (CellError, WaggleError, etc.) leave `data`
 *     undefined — their subCodes stay opaque to the wire.
 *   - Privacy invariant (PRY-023): the sanitizer whitelists only the three
 *     fields `{path, code, message}`. Notably, zod's `received` field — the
 *     value the caller sent — is NEVER echoed (PII / echo-amplification risk).
 */
export interface WireError {
  code: McpErrorCode;
  message: string;
  data?: unknown;
}

/**
 * Internal helper carried by `mapDomainError` so the caller can both throw the
 * wire error AND log the rich context. Tests assert against this shape.
 */
export interface MappedError {
  wire: WireError;
  /** Original domain code for log only. e.g. `RECIPIENT_UNREACHABLE`. */
  domainCode: string | null;
  /** Original sub-code for log only. e.g. `cell_closed_or_missing`. */
  subCode: string | null;
}
