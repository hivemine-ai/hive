// Auth binding: the HTTP edge verifies the Bearer on every POST to the MCP path and
// hands the resulting identity to the SDK as the authInfo of that request. Nothing
// is stored between requests, so two concurrent requests can never cross identities.

import type { AuthInfo } from '@modelcontextprotocol/server';
import { decodeJwt } from 'jose';

import { AuthError } from '#domain/auth/index.js';
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

export const REGISTER_SESSION_TOOL = 'register_session';

/**
 * Name of the operation a JSON-RPC body asks for, as the scope binding and its
 * `operation` log field call it: `tools_call:<name>`, `tools_list`, `resources`,
 * `subscriptions_listen`, `server_discover`, or the raw method otherwise.
 */
export function requestOperation(body: unknown): string {
  const rpc = body as { method?: unknown; params?: { name?: unknown } } | null | undefined;
  const method = rpc?.method;
  if (typeof method !== 'string') return 'unknown';
  if (method === 'tools/call') return `tools_call:${String(rpc?.params?.name)}`;
  if (method === 'tools/list') return 'tools_list';
  if (method.startsWith('resources/')) return 'resources';
  if (method === 'subscriptions/listen') return 'subscriptions_listen';
  if (method === 'server/discover') return 'server_discover';
  return method;
}

// What an enrollment credential may do (ADR-026): register, and detect a version skew.
const ENROLL_ALLOWED_OPERATIONS: ReadonlySet<string> = new Set([
  `tools_call:${REGISTER_SESSION_TOOL}`,
  'server_discover',
]);

// Routing only: the claims are read unverified to choose the verifier variant, and that
// variant then checks everything. A Bearer that does not decode goes to `verify`.
function bearerHasScope(authorizationHeader: string | undefined): boolean | undefined {
  const token = authorizationHeader?.match(/^[Bb]earer\s+(.+)$/)?.[1];
  if (token === undefined) return undefined;
  try {
    return decodeJwt(token)['scope'] !== undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies the `Authorization` header of a request whose parsed body is `body`.
 *
 * - `register_session` with a Bearer without `scope` is a renewal: the Bearer is the
 *   holder proof and goes to `verifyRenewalBearer` (accepted expired inside the window).
 * - Everything else goes to `verify`. An enrollment credential (`scope = enroll`) then
 *   passes only for `register_session` and `server/discover`; any other operation fails
 *   with INSUFFICIENT_PRIVILEGE{scoped_credential} (wire 403, -32006).
 * - Throws the original `AuthError` on failure (caller maps it to the wire via
 *   `mapDomainError`). Infrastructure failures propagate as they are.
 */
export async function verifyBearerHeader(
  verifier: Pick<Verifier, 'verify' | 'verifyRenewalBearer'>,
  authorizationHeader: string | undefined,
  body: unknown,
): Promise<AuthenticatedRequest> {
  const operation = requestOperation(body);
  if (
    operation === `tools_call:${REGISTER_SESSION_TOOL}` &&
    bearerHasScope(authorizationHeader) === false
  ) {
    return { identity: await verifier.verifyRenewalBearer(authorizationHeader) };
  }
  const identity = await verifier.verify(authorizationHeader);
  if (identity.snapshot.scope !== undefined && !ENROLL_ALLOWED_OPERATIONS.has(operation)) {
    throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode: 'scoped_credential' });
  }
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
