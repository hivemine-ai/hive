// Auth binding: thin wrapper around `verifier.verify` that the fastify hook
// invokes for every POST /mcp request.
//
// Decision local del PRY-006: verification runs per HTTP request, NOT once at
// `initialize` and cached. The MCP SDK 1.29.0 does not expose an on-initialize
// hook with access to the original HTTP request, so the natural place to bind
// identity is the fastify `onRequest` hook. Cost is bounded (~1ms with warm
// blocklist + Ed25519 verify) and the freshness of the participant's `state`
// vigente is improved as a side effect. The `HIVE_MCP_REVERIFY_INTERVAL_SECONDS`
// env var documented in the tech spec is reserved for v0.2+ — not implemented
// in Slice 0.

import type { IdentityContext, Verifier } from '#domain/auth/index.js';

/**
 * Output of `verifyBearerHeader` — the resolved identity. Request correlation
 * (the `requestId`) lives in `request.log` bindings via the
 * `attachRequestIdHook` (Observability tech spec § Correlación
 * cross-component); downstream callers read it via `getRequestIdFromLogger`.
 */
export interface AuthenticatedRequest {
  identity: IdentityContext;
}

/**
 * Verifies the `Authorization` header against the Auth + Identity verifier.
 *
 * - Returns `AuthenticatedRequest` on success.
 * - Throws the original `AuthError` from the verifier on failure (caller maps
 *   to the wire via `mapDomainError`).
 */
export async function verifyBearerHeader(
  verifier: Verifier,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedRequest> {
  const identity = await verifier.verify(authorizationHeader);
  return { identity };
}
