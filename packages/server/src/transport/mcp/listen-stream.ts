// Edge of `subscriptions/listen`. The SDK router filters by URI but does not know the
// caller, does not check who owns a URI and exposes neither open nor close, so this edge
// wraps its handler and supplies the three things: authorization before the SDK, the
// stream registered as presence, and the close.
//
// Only the caller's own mailbox can be subscribed, so a non-empty `resourceSubscriptions`
// that passed `authorize` is the own mailbox and counts as presence. An empty one, which
// is how Claude Code opens its own stream, is served and never counts, but it has the
// same lifecycle: keep-alive, expiry, re-verification and `complete` on shutdown.
//
// Lease (opt-in): a listen that carries `Hive-Listen-Lease: <key>` gets a lease of
// `leaseMs`, announced back in `Hive-Listen-Lease-Ms`. The client renews it by sending
// `server/discover` with the same key. Keys are bound to the participant that opened
// the stream, so another participant carrying the same key renews nothing. A stream
// without the header keeps today's behaviour and never expires for silence.

import { v7 as uuidv7 } from 'uuid';

import type { IdentityContext, UUIDv7, Verifier } from '#domain/auth/index.js';
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
import { createStreamHandle, type StreamHandle } from './subscriber-handle.js';
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
  /** Lease granted to a listen that asks for one. Null disables leases: the header is ignored. */
  leaseMs: number | null;
}

export interface ListenStreams extends ListenEdge {
  /** Starts the single re-verification timer of the process. */
  start(): void;
  /**
   * Stops the timer and ends with `complete` whatever is still open. Call it after
   * `presenceRegistry.shutdown()`: streams without presence are not in the registry.
   */
  stop(): void;
  /**
   * ADR-026: after a register_session renewal, every open presence stream of the
   * participant takes the `jti` and `exp` of the new token, for its close-on-expiry and
   * its re-verification. Returns how many streams were re-bound (0 is valid).
   */
  rebindParticipantStreams(
    participantId: UUIDv7,
    credential: { jti: UUIDv7; expiresAt: Date },
  ): number;
  /** One pass over the open streams. Public for tests. */
  reverifyOpenStreams(): Promise<void>;
  /** Test helper — streams being tracked. */
  __openCount(): number;
}

interface OpenStream {
  handle: StreamHandle;
  identity: IdentityContext;
  countsAsPresence: boolean;
  /** The token the stream lives on: the one it was opened with, or the last re-bound. */
  credential: { jti: UUIDv7; expiresAt: Date | undefined };
}

export const LEASE_RESPONSE_HEADER = 'hive-listen-lease-ms';

/** Long enough to be unguessable, short enough to bound the map key. */
const LEASE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function leaseSlot(participantId: string, key: string): string {
  return `${participantId}:${key}`;
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
  const leases = new Map<string, StreamHandle>();
  let reverifyTimer: NodeJS.Timeout | undefined;
  let reverifying = false;

  function reject(reason: 'foreign_uri' | 'invalid_params', identity: IdentityContext): WireError {
    logger.warn(
      { event: 'mcp_listen_rejected', reason, participantId: identity.participantId },
      'listen rejected',
    );
    return INVALID_INPUT;
  }

  function track(
    input: ListenResponseInput,
    streamId: string,
    subscribesOwnMailbox: boolean,
    resourceSubscriptionsCount: number,
  ): StreamHandle {
    const { body, identity, requestId, raw, abort } = input;
    const leaseKey =
      deps.leaseMs !== null &&
      input.leaseKey !== undefined &&
      LEASE_KEY_PATTERN.test(input.leaseKey)
        ? input.leaseKey
        : undefined;
    const handle = createStreamHandle({
      callerContext: identity,
      sink: raw,
      subscriptionId: rpcId(body),
      serverInfo: deps.serverInfo,
      abort,
      keepAliveIntervalMs: deps.keepAliveIntervalMs,
      stallTimeoutMs: deps.stallTimeoutMs,
      logger,
      ...(leaseKey !== undefined && deps.leaseMs !== null && { leaseMs: deps.leaseMs }),
    });
    raw.socket?.setKeepAlive(true, deps.keepAliveIntervalMs);
    const leaseMs = leaseKey !== undefined ? deps.leaseMs : null;
    let slot: string | undefined;
    if (leaseKey !== undefined) {
      slot = leaseSlot(identity.participantId, leaseKey);
      leases.set(slot, handle);
      raw.setHeader(LEASE_RESPONSE_HEADER, String(leaseMs));
    }

    const fields = {
      streamId,
      connectionId: handle.connectionId,
      participantId: identity.participantId,
      subscribesOwnMailbox,
    };
    logger.info(
      { event: 'mcp_listen_opened', ...fields, resourceSubscriptionsCount, leaseMs, requestId },
      'listen stream opened',
    );
    open.set(handle.connectionId, {
      handle,
      identity,
      countsAsPresence: subscribesOwnMailbox,
      credential: {
        jti: identity.snapshot.credentialJti,
        expiresAt: identity.snapshot.credentialExpiresAt,
      },
    });
    const openedAt = Date.now();
    handle.onClose((closeReason) => {
      open.delete(handle.connectionId);
      if (slot !== undefined && leases.get(slot) === handle) leases.delete(slot);
      logger.info(
        {
          event: 'mcp_listen_closed',
          ...fields,
          closeReason,
          streamDurationMs: Date.now() - openedAt,
        },
        'listen stream closed',
      );
    });
    return handle;
  }

  function bindPresence(handle: SubscriberHandle, input: ListenResponseInput): ListenBinding {
    const { identity, requestId } = input;
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
      for (const { handle, identity, credential } of Array.from(open.values())) {
        try {
          const verdict = await deps.verifier.reverifyStream({
            jti: credential.jti,
            participantId: identity.participantId,
            credentialExpiresAt: credential.expiresAt ?? NO_EXPIRY,
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
      const handle = track(input, streamId, count > 0, count);
      return count > 0 ? bindPresence(handle, input) : undefined;
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
      for (const { handle } of Array.from(open.values())) handle.close('shutdown');
    },

    renewLease({ key, identity }) {
      return leases.get(leaseSlot(identity.participantId, key))?.renewLease() ?? false;
    },

    rebindParticipantStreams(participantId, credential) {
      let rebound = 0;
      for (const stream of open.values()) {
        if (!stream.countsAsPresence || stream.identity.participantId !== participantId) continue;
        stream.credential = { jti: credential.jti, expiresAt: credential.expiresAt };
        stream.handle.rearmCredentialExpiry(credential.expiresAt);
        rebound += 1;
      }
      return rebound;
    },

    reverifyOpenStreams,

    __openCount() {
      return open.size;
    },
  };
}
