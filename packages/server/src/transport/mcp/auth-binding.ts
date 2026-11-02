// Auth binding: the HTTP edge verifies the Bearer on every POST to the MCP path and
// hands the resulting identity to the SDK as the authInfo of that request. Nothing
// is stored between requests, so two concurrent requests can never cross identities.

import type { AuthInfo } from '@modelcontextprotocol/server';

import type { IdentityContext, UUIDv7, Verifier } from '#domain/auth/index.js';
import type { Logger } from '#observability/logger.js';

import type { RequestContext } from './types.js';

/** Upper bound on how stale `agents.last_connected_at` can be for an active agent. */
const LAST_CONNECTED_THROTTLE_MS = 30_000;

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
 *   to the wire via `mapDomainError`). Infrastructure failures propagate as they are.
 */
export async function verifyBearerHeader(
  verifier: Verifier,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedRequest> {
  const identity = await verifier.verify(authorizationHeader);
  return { identity };
}

/** Packs the verified request context into the SDK `authInfo`, which it passes through. */
export function toAuthInfo(context: RequestContext): AuthInfo {
  return {
    // The SDK never reads it, and the raw Bearer has no reason to travel further.
    token: '',
    clientId: context.identity.participantId,
    scopes: [],
    extra: { hiveContext: context },
  };
}

/** Recovers the context of the request in progress inside an SDK handler. */
export function requestContextFrom(authInfo: AuthInfo | undefined): RequestContext {
  const context = authInfo?.extra?.['hiveContext'];
  if (context === undefined) {
    throw new Error('MCP handler reached without a verified request context');
  }
  return context as RequestContext;
}

export interface LastConnectedRefresherDeps {
  participantsRepo: { updateAgentLastConnectedAt(agentId: UUIDv7, timestamp: Date): Promise<void> };
  logger: Logger;
  throttleMs?: number;
  now?: () => Date;
}

export interface LastConnectedRefresher {
  /** Fire and forget: never blocks the request, and a failed write is only logged. */
  refresh(identity: IdentityContext): void;
}

/**
 * Refreshes `agents.last_connected_at` on any authenticated request of a Worker or
 * Scout, throttled per participant so a chatty agent does not cost one UPDATE per call.
 */
export function createLastConnectedRefresher(
  deps: LastConnectedRefresherDeps,
): LastConnectedRefresher {
  const throttleMs = deps.throttleMs ?? LAST_CONNECTED_THROTTLE_MS;
  const now = deps.now ?? (() => new Date());
  const lastWriteMs = new Map<UUIDv7, number>();

  return {
    refresh(identity) {
      if (identity.kind === 'hivekeeper') return;
      const participantId = identity.participantId;
      const at = now();
      const previous = lastWriteMs.get(participantId);
      if (previous !== undefined && at.getTime() - previous < throttleMs) return;

      lastWriteMs.set(participantId, at.getTime());
      deps.participantsRepo.updateAgentLastConnectedAt(participantId, at).catch((err: unknown) => {
        lastWriteMs.delete(participantId);
        deps.logger.warn(
          {
            event: 'mcp_last_connected_refresh_failed',
            participantId,
            err: err instanceof Error ? err.message : String(err),
          },
          'last_connected_at refresh failed',
        );
      });
    },
  };
}
