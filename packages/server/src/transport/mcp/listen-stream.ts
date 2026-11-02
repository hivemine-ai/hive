// Edge of `subscriptions/listen`. The SDK router filters by URI but does not know the
// caller, does not check who owns a URI and exposes neither open nor close, so this edge
// wraps its handler and supplies the three things: authorization before the SDK, the
// stream registered as presence, and the close.
//
// Only the caller's own mailbox can be subscribed, so a non-empty `resourceSubscriptions`
// that passed `authorize` is the own mailbox and counts as presence. An empty one, which
// is how Claude Code opens its own stream, is served and never counts.

import type { ServerResponse } from 'node:http';

import { v7 as uuidv7 } from 'uuid';

import type { IdentityContext, Verifier } from '#domain/auth/index.js';
import type { CellsRepo } from '#domain/cells/index.js';
import { isWaggleError } from '#domain/notifications/index.js';
import type {
  PresenceRegistry,
  StreamCloseReason,
  SubscriberHandle,
  Subscription,
} from '#domain/notifications/index.js';
import type { Logger } from '#observability/logger.js';

import { MCP_ERR_INVALID_PARAMS } from './error-codes.js';
import type { ListenBinding, ListenEdge, ListenResponseInput } from './http-host.js';
import { mailboxUri } from './resources.js';
import { createStreamHandle } from './subscriber-handle.js';
import type { WireError } from './types.js';

export interface ListenStreamsDeps {
  cellsRepo: Pick<CellsRepo, 'findCellByOwner'>;
  presenceRegistry: Pick<PresenceRegistry, 'subscribe'>;
  verifier: Pick<Verifier, 'reverifyStream'>;
  serverInfo: { name: string; version: string };
  logger: Logger;
  keepAliveIntervalMs: number;
  stallTimeoutMs: number;
  /** 0 disables the periodic pass. */
  reverifyIntervalSeconds: number;
}

export interface ListenStreams extends ListenEdge {
  /** Starts the single re-verification timer of the process. */
  start(): void;
  stop(): void;
  /** One pass over the open streams. Public for tests. */
  reverifyOpenStreams(): Promise<void>;
  /** Test helper — streams being tracked. */
  __openCount(): number;
}

interface OpenStream {
  handle: SubscriberHandle;
  identity: IdentityContext;
}

const INVALID_INPUT: WireError = { code: MCP_ERR_INVALID_PARAMS, message: 'invalid input' };

/** No `exp` in the token: nothing to enforce, so the check must never trigger. */
const NO_EXPIRY = new Date(8.64e15);

const REVERIFY_CLOSE_REASON = {
  credential_expired: 'credential_expired',
  credential_revoked: 'participant_revoked',
  participant_not_found: 'participant_revoked',
  participant_revoked: 'participant_revoked',
  participant_suspended: 'participant_suspended',
} as const;

function requestedSubscriptions(body: unknown): unknown {
  const params = (body as { params?: { notifications?: { resourceSubscriptions?: unknown } } })
    .params;
  return params?.notifications?.resourceSubscriptions;
}

function rpcId(body: unknown): string | number {
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : 0;
}

function subscribeFailureReason(subCode: string | undefined): StreamCloseReason {
  if (subCode === 'registry_shut_down') return 'shutdown';
  if (subCode === 'suspended') return 'participant_suspended';
  return 'participant_revoked';
}

export function createListenStreams(deps: ListenStreamsDeps): ListenStreams {
  const { logger } = deps;
  const open = new Map<string, OpenStream>();
  let reverifyTimer: NodeJS.Timeout | undefined;
  let reverifying = false;

  function reject(reason: 'foreign_uri' | 'invalid_params', identity: IdentityContext): WireError {
    logger.warn(
      { event: 'mcp_listen_rejected', reason, participantId: identity.participantId },
      'listen rejected',
    );
    return INVALID_INPUT;
  }

  function logOpened(
    streamId: string,
    connectionId: string | null,
    identity: IdentityContext,
    subscribesOwnMailbox: boolean,
    resourceSubscriptionsCount: number,
    requestId: string,
  ): void {
    logger.info(
      {
        event: 'mcp_listen_opened',
        streamId,
        connectionId,
        participantId: identity.participantId,
        subscribesOwnMailbox,
        resourceSubscriptionsCount,
        requestId,
      },
      'listen stream opened',
    );
  }

  function closedLogger(
    streamId: string,
    connectionId: string | null,
    identity: IdentityContext,
    subscribesOwnMailbox: boolean,
  ): (closeReason: StreamCloseReason) => void {
    const openedAt = Date.now();
    return (closeReason) => {
      logger.info(
        {
          event: 'mcp_listen_closed',
          streamId,
          connectionId,
          participantId: identity.participantId,
          subscribesOwnMailbox,
          closeReason,
          streamDurationMs: Date.now() - openedAt,
        },
        'listen stream closed',
      );
    };
  }

  function serveWithoutPresence(
    raw: ServerResponse,
    identity: IdentityContext,
    streamId: string,
    requestId: string,
  ): void {
    logOpened(streamId, null, identity, false, 0, requestId);
    const logClosed = closedLogger(streamId, null, identity, false);
    raw.once('close', () => {
      logClosed('client_closed');
    });
  }

  function bindPresence(
    input: ListenResponseInput,
    streamId: string,
    count: number,
  ): ListenBinding {
    const { body, identity, requestId, raw, abort } = input;
    const handle = createStreamHandle({
      callerContext: identity,
      sink: raw,
      subscriptionId: rpcId(body),
      serverInfo: deps.serverInfo,
      abort,
      keepAliveIntervalMs: deps.keepAliveIntervalMs,
      stallTimeoutMs: deps.stallTimeoutMs,
      logger,
    });
    raw.socket?.setKeepAlive(true, deps.keepAliveIntervalMs);

    logOpened(streamId, handle.connectionId, identity, true, count, requestId);
    open.set(handle.connectionId, { handle, identity });
    const logClosed = closedLogger(streamId, handle.connectionId, identity, true);
    handle.onClose((reason) => {
      open.delete(handle.connectionId);
      logClosed(reason);
    });

    let acknowledged = false;
    let subscription: Subscription | undefined;
    deps.presenceRegistry.subscribe({ callerContext: identity, handle, requestId }).then(
      (created) => {
        subscription = created;
        if (acknowledged) created.ready();
      },
      (err: unknown) => {
        const code = isWaggleError(err) ? err.code : 'INTERNAL';
        const subCode = isWaggleError(err) ? err.subCode : undefined;
        const closeReason = subscribeFailureReason(subCode);
        logger.warn(
          {
            event: 'mcp_subscribe_failed',
            code,
            subCode,
            closeReason,
            participantId: identity.participantId,
          },
          'presence subscribe failed',
        );
        handle.close(closeReason);
      },
    );

    return {
      onAcknowledged() {
        acknowledged = true;
        subscription?.ready();
      },
    };
  }

  async function reverifyOpenStreams(): Promise<void> {
    if (reverifying) return;
    reverifying = true;
    try {
      for (const { handle, identity } of Array.from(open.values())) {
        try {
          const verdict = await deps.verifier.reverifyStream({
            jti: identity.snapshot.credentialJti,
            participantId: identity.participantId,
            credentialExpiresAt: identity.snapshot.credentialExpiresAt ?? NO_EXPIRY,
          });
          if (!verdict.ok) handle.close(REVERIFY_CLOSE_REASON[verdict.reason]);
        } catch (err) {
          // An infrastructure failure says nothing about the credential: keep the stream
          // and try again on the next pass.
          logger.warn(
            {
              event: 'mcp_listen_reverify_failed',
              connectionId: handle.connectionId,
              participantId: identity.participantId,
              err: err instanceof Error ? err.message : String(err),
            },
            'stream re-verification failed; keeping the stream',
          );
        }
      }
    } finally {
      reverifying = false;
    }
  }

  return {
    async authorize({ body, identity }) {
      const uris = requestedSubscriptions(body);
      // Absent means no `notifications` filter to authorize: the SDK validates that shape.
      if (uris === undefined) return null;
      if (!Array.isArray(uris) || uris.some((uri) => typeof uri !== 'string')) {
        return reject('invalid_params', identity);
      }
      if (uris.length === 0) return null;
      const cell = await deps.cellsRepo.findCellByOwner(identity.participantId);
      const own = cell ? mailboxUri(cell.id) : undefined;
      return uris.every((uri) => uri === own) ? null : reject('foreign_uri', identity);
    },

    onResponse(input) {
      const contentType = input.response.headers.get('content-type') ?? '';
      if (input.response.status !== 200 || !contentType.startsWith('text/event-stream')) {
        return undefined;
      }
      const streamId = uuidv7();
      const uris = requestedSubscriptions(input.body);
      const count = Array.isArray(uris) ? uris.length : 0;
      if (count === 0) {
        serveWithoutPresence(input.raw, input.identity, streamId, input.requestId);
        return undefined;
      }
      return bindPresence(input, streamId, count);
    },

    start() {
      if (deps.reverifyIntervalSeconds <= 0 || reverifyTimer !== undefined) return;
      reverifyTimer = setInterval(() => {
        void reverifyOpenStreams();
      }, deps.reverifyIntervalSeconds * 1000);
      reverifyTimer.unref();
    },

    stop() {
      clearInterval(reverifyTimer);
      reverifyTimer = undefined;
    },

    reverifyOpenStreams,

    __openCount() {
      return open.size;
    },
  };
}
