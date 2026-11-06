// Presence Registry — in-memory map participantId → connectionId → ActiveSubscriber.
//
// One entry = one open `subscriptions/listen` stream that subscribes the
// participant's own mailbox. An entry lives exactly as long as its stream:
// there is no sweep, no inactivity threshold and no timer. The handle owns
// network-failure detection (keep-alive + stall detector) and reports the end
// of the stream through `onClose`; the registry only reacts. This is the fix
// for INC-2026-007 (an idle-but-alive stream used to be evicted for lack of delivery traffic).
//
// Entry states:
//   pending — registered, acknowledgment not yet written. Not online, no fan-out.
//   open    — `Subscription.ready()` called after the acknowledgment. Online.
//
// Concurrency: Node's event loop serializes Map mutations; no locks needed.
// `forEachSubscriber` snapshots the handles before iterating so a handle that
// unsubscribes mid-fan-out does not corrupt the loop.

import { v7 as uuidv7 } from 'uuid';

import type { ParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import { WaggleError } from '../errors.js';

import type { StreamCloseReason, SubscriberHandle } from './subscriber-handle.js';
import type { PresenceSnapshot, SubscribeInput, Subscription } from './types.js';

type StreamState = 'pending' | 'open';

interface ActiveSubscriber {
  subscriptionId: UUIDv7;
  participantId: UUIDv7;
  handle: SubscriberHandle;
  /** Ordering key for LRU. Never refreshed by traffic. */
  subscribedAt: Date;
  /** Correlates logs with the POST that opened the stream. */
  requestId: string;
  state: StreamState;
}

interface ParticipantPresence {
  subscriberByConnection: Map<UUIDv7, ActiveSubscriber>;
}

/** Hook payload fired when a stream becomes `open`. Composition wires the replay scheduler here. */
export interface ReadyHookInput {
  participantId: UUIDv7;
  subscriptionId: UUIDv7;
  handle: SubscriberHandle;
}

export interface PresenceRegistryConfig {
  /** Cap of simultaneous streams per participant. Default 16. */
  maxSessionsPerParticipant?: number;
  /** Fired by `Subscription.ready()` — composition wires `replay.scheduleReplayFor` here. */
  onReady?: (input: ReadyHookInput) => void;
  /** Clock factory. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Logger for presence events. Optional — without it the registry is silent. */
  logger?: Logger;
  /**
   * Source of the live participant state. `subscribe` re-reads it (instead of
   * trusting the request snapshot) as its last await before inserting, which
   * closes the suspension/subscribe race. Without it the snapshot state is used.
   */
  participantsRepo?: Pick<ParticipantsReadRepo, 'getParticipantState'>;
  /** HIVE_PRESENCE_CLAIM_RESERVATION_MS: life of a `claimHolder` reservation. Default 10 s. */
  claimReservationMs?: number;
}

export type ClaimHolderResult = { outcome: 'granted' } | { outcome: 'in_use' };

export interface PresenceRegistry {
  /**
   * Registers a `pending` entry. At the cap the oldest stream is evicted (closed
   * with `evicted_lru`) — subscribe never rejects for the cap.
   */
  subscribe(input: SubscribeInput): Promise<Subscription>;
  /**
   * Idempotent. Removes the entry (lookup O(n) per participant; n ≤ cap). Does
   * NOT call `handle.close()`: the stream is already gone or being closed by its owner.
   */
  unsubscribe(subscriptionId: UUIDv7, participantId: UUIDv7, reason: StreamCloseReason): void;
  /** True iff the entry exists and is `open`. Pure read. */
  isOpen(subscriptionId: UUIDv7, participantId: UUIDv7): boolean;
  /** Pure read; counts only `open` entries. `online === (streamCount > 0)`. */
  getPresence(participantId: UUIDv7): PresenceSnapshot;
  /**
   * Snapshot-then-iterate fan-out over `open` entries only. Sequential `await`
   * per handle; errors thrown by `fn` are isolated and reported via `onError`.
   */
  forEachSubscriber(
    participantId: UUIDv7,
    fn: (handle: SubscriberHandle) => Promise<void>,
    onError?: (handle: SubscriberHandle, err: unknown) => void,
  ): Promise<void>;
  /** `open` streams of the participant, for a replay per stream on resume. */
  listOpenStreams(participantId: UUIDv7): ReadyHookInput[];
  /** Forced close of every stream of the participant (revocation, suspension, retirement). Idempotent. */
  closeParticipantStreams(
    participantId: UUIDv7,
    reason: Extract<
      StreamCloseReason,
      'participant_revoked' | 'participant_suspended' | 'participant_retired'
    >,
  ): void;
  /**
   * ADR-026. Pure and synchronous: true iff the participant has at least one `open`
   * entry. A leased handle closes itself when the lease runs out, so an `open` entry
   * is lease-less or holds a live lease; a `pending` one does not count.
   */
  isHolderLive(participantId: UUIDv7): boolean;
  /**
   * ADR-026. Serialization point of a name claim on an offline holder. Synchronous, so
   * two concurrent claims are ordered by the event loop and exactly one is `granted`.
   * In order: a live holder → `in_use`; a live reservation of another claimId →
   * `in_use`; otherwise installs the reservation → `granted`. Idempotent per claimId,
   * without extending the reservation. Never throws.
   */
  claimHolder(participantId: UUIDv7, claimId: UUIDv7): ClaimHolderResult;
  /** Frees the reservation if it belongs to `claimId`. Idempotent; no-op otherwise. */
  releaseClaim(participantId: UUIDv7, claimId: UUIDv7): void;
  /** Closes every stream with `shutdown`, empties the registry and rejects later subscribes. Idempotent. */
  shutdown(): void;
  /** Test helper — live entry count (pending + open) for a participant. */
  __streamCount(participantId: UUIDv7): number;
}

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_CLAIM_RESERVATION_MS = 10_000;

export function createPresenceRegistry(config: PresenceRegistryConfig = {}): PresenceRegistry {
  const presenceMap = new Map<UUIDv7, ParticipantPresence>();
  const maxSessions = config.maxSessionsPerParticipant ?? DEFAULT_MAX_SESSIONS;
  const now = config.now ?? ((): Date => new Date());
  const logger = config.logger;
  const claimReservationMs = config.claimReservationMs ?? DEFAULT_CLAIM_RESERVATION_MS;
  // A reservation is consumed by the claimant's ready(), released, or simply expires.
  const reservations = new Map<UUIDv7, { claimId: UUIDv7; expiresAtMs: number }>();
  let isShutDown = false;

  function openCount(presence: ParticipantPresence | undefined): number {
    if (presence === undefined) return 0;
    let n = 0;
    for (const sub of presence.subscriberByConnection.values()) {
      if (sub.state === 'open') n += 1;
    }
    return n;
  }

  function findEntry(
    subscriptionId: UUIDv7,
    participantId: UUIDv7,
  ): { presence: ParticipantPresence; connectionId: UUIDv7; entry: ActiveSubscriber } | undefined {
    const presence = presenceMap.get(participantId);
    if (presence === undefined) return undefined;
    for (const [connectionId, entry] of presence.subscriberByConnection) {
      if (entry.subscriptionId === subscriptionId) return { presence, connectionId, entry };
    }
    return undefined;
  }

  // Single removal path: every cause of removal funnels here so none can skip
  // the `presence_stream_offline` emission (open → removed, last open stream).
  function removeEntry(
    presence: ParticipantPresence,
    connectionId: UUIDv7,
    entry: ActiveSubscriber,
    reason: StreamCloseReason,
  ): void {
    presence.subscriberByConnection.delete(connectionId);
    if (presence.subscriberByConnection.size === 0) {
      presenceMap.delete(entry.participantId);
    }
    if (entry.state === 'open' && openCount(presence) === 0) {
      logger?.info(
        {
          event: 'presence_stream_offline',
          participantId: entry.participantId,
          closeReason: reason,
          streamDurationMs: now().getTime() - entry.subscribedAt.getTime(),
          requestId: entry.requestId,
        },
        'presence stream offline',
      );
    }
  }

  function unsubscribeImpl(
    subscriptionId: UUIDv7,
    participantId: UUIDv7,
    reason: StreamCloseReason,
  ): void {
    const found = findEntry(subscriptionId, participantId);
    if (found === undefined) return;
    removeEntry(found.presence, found.connectionId, found.entry, reason);
  }

  function safeClose(handle: SubscriberHandle, reason: StreamCloseReason, context: object): void {
    try {
      handle.close(reason);
    } catch (err) {
      logger?.warn(
        {
          event: 'presence_handle_close_failed',
          ...context,
          closeReason: reason,
          err: err instanceof Error ? err.message : String(err),
        },
        'handle.close threw; entry already removed',
      );
    }
  }

  function evictOldest(participantId: UUIDv7, presence: ParticipantPresence): void {
    let victimKey: UUIDv7 | undefined;
    let victim: ActiveSubscriber | undefined;
    // Strict `<` keeps the earliest-inserted entry on a timestamp tie.
    for (const [key, sub] of presence.subscriberByConnection) {
      if (victim === undefined || sub.subscribedAt.getTime() < victim.subscribedAt.getTime()) {
        victimKey = key;
        victim = sub;
      }
    }
    if (victim === undefined || victimKey === undefined) return;
    // Remove first so the cap slot is free even if close() misbehaves.
    removeEntry(presence, victimKey, victim, 'evicted_lru');
    logger?.info(
      {
        event: 'presence_stream_evicted_lru',
        participantId,
        victimSubscriptionId: victim.subscriptionId,
        victimSubscribedAt: victim.subscribedAt.toISOString(),
      },
      'presence stream evicted at cap',
    );
    safeClose(victim.handle, 'evicted_lru', {
      participantId,
      subscriptionId: victim.subscriptionId,
    });
  }

  function closeAll(participantId: UUIDv7, reason: StreamCloseReason): void {
    const presence = presenceMap.get(participantId);
    if (presence === undefined) return;
    const entries = Array.from(presence.subscriberByConnection.entries());
    for (const [connectionId, entry] of entries) {
      removeEntry(presence, connectionId, entry, reason);
      safeClose(entry.handle, reason, { participantId, subscriptionId: entry.subscriptionId });
    }
  }

  return {
    async subscribe(input) {
      if (isShutDown) {
        throw new WaggleError('INVALID_INPUT', {
          subCode: 'registry_shut_down',
          message: 'Presence registry is shut down; subscribe rejected',
        });
      }
      const participantId = input.callerContext.participantId;

      // Fresh state check. Must be the LAST await before the insertion below:
      // a suspension applied before this read is seen here; one applied after
      // the insertion closes the entry through `closeParticipantStreams`.
      let state: string = input.callerContext.current.state;
      if (state === 'active' && config.participantsRepo !== undefined) {
        const live = await config.participantsRepo.getParticipantState(participantId);
        state = live?.state ?? 'not_found';
      }
      if (state !== 'active') {
        throw new WaggleError('PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE', {
          subCode: state,
          message: 'Participant is not active; subscribe rejected',
        });
      }
      // The shutdown may have happened while awaiting the state read.
      if (isShutDown) {
        throw new WaggleError('INVALID_INPUT', {
          subCode: 'registry_shut_down',
          message: 'Presence registry is shut down; subscribe rejected',
        });
      }

      // A handle re-registered under the same connectionId replaces its entry
      // instead of counting twice (buggy transport self-sabotages, nobody else).
      const connectionId = input.handle.connectionId;
      const current = presenceMap.get(participantId);
      const existing = current?.subscriberByConnection.get(connectionId);
      if (current !== undefined && existing !== undefined) {
        removeEntry(current, connectionId, existing, 'client_closed');
      }

      const beforeInsert = presenceMap.get(participantId);
      if (beforeInsert !== undefined && beforeInsert.subscriberByConnection.size >= maxSessions) {
        evictOldest(participantId, beforeInsert);
      }

      let presence = presenceMap.get(participantId);
      if (presence === undefined) {
        presence = { subscriberByConnection: new Map() };
        presenceMap.set(participantId, presence);
      }

      const subscriptionId = uuidv7();
      const subscribedAt = now();
      const entry: ActiveSubscriber = {
        subscriptionId,
        participantId,
        handle: input.handle,
        subscribedAt,
        requestId: input.requestId ?? uuidv7(),
        state: 'pending',
      };
      presence.subscriberByConnection.set(connectionId, entry);

      input.handle.onClose((reason) => {
        unsubscribeImpl(subscriptionId, participantId, reason);
      });

      const subscription: Subscription = {
        id: subscriptionId,
        participantId,
        subscribedAt,
        ready() {
          const found = findEntry(subscriptionId, participantId);
          if (found === undefined || found.entry.state === 'open') return;
          const wasOnline = openCount(found.presence) > 0;
          found.entry.state = 'open';
          reservations.delete(participantId);
          if (!wasOnline) {
            logger?.info(
              {
                event: 'presence_stream_online',
                participantId,
                streamCount: openCount(found.presence),
                requestId: found.entry.requestId,
              },
              'presence stream online',
            );
          }
          try {
            config.onReady?.({ participantId, subscriptionId, handle: input.handle });
          } catch (err) {
            // A buggy hook must not break the stream; the client can still
            // recover through check_unread_messages.
            logger?.warn(
              {
                event: 'presence_on_ready_hook_failed',
                participantId,
                subscriptionId,
                err: err instanceof Error ? err.message : String(err),
              },
              'onReady hook threw',
            );
          }
        },
        close(reason = 'client_closed') {
          unsubscribeImpl(subscriptionId, participantId, reason);
        },
      };
      return subscription;
    },

    unsubscribe: unsubscribeImpl,

    isOpen(subscriptionId, participantId) {
      return findEntry(subscriptionId, participantId)?.entry.state === 'open';
    },

    getPresence(participantId) {
      const presence = presenceMap.get(participantId);
      const streamsSubscribedAt: Date[] = [];
      if (presence !== undefined) {
        for (const sub of presence.subscriberByConnection.values()) {
          if (sub.state === 'open') streamsSubscribedAt.push(sub.subscribedAt);
        }
      }
      return {
        online: streamsSubscribedAt.length > 0,
        streamCount: streamsSubscribedAt.length,
        streamsSubscribedAt,
      };
    },

    async forEachSubscriber(participantId, fn, onError) {
      const presence = presenceMap.get(participantId);
      if (presence === undefined) return;
      const handles: SubscriberHandle[] = [];
      for (const sub of presence.subscriberByConnection.values()) {
        if (sub.state === 'open') handles.push(sub.handle);
      }
      for (const handle of handles) {
        try {
          await fn(handle);
        } catch (err) {
          // Error-isolated per handle: one zombie does not block the rest.
          if (onError) {
            try {
              onError(handle, err);
            } catch {
              // Sink itself threw; nothing to do.
            }
          }
        }
      }
    },

    listOpenStreams(participantId) {
      const presence = presenceMap.get(participantId);
      if (presence === undefined) return [];
      return Array.from(presence.subscriberByConnection.values())
        .filter((sub) => sub.state === 'open')
        .map((sub) => ({ participantId, subscriptionId: sub.subscriptionId, handle: sub.handle }));
    },

    isHolderLive(participantId) {
      return openCount(presenceMap.get(participantId)) > 0;
    },

    claimHolder(participantId, claimId) {
      if (openCount(presenceMap.get(participantId)) > 0) return { outcome: 'in_use' };
      const nowMs = now().getTime();
      const current = reservations.get(participantId);
      if (current !== undefined && current.expiresAtMs > nowMs) {
        return current.claimId === claimId ? { outcome: 'granted' } : { outcome: 'in_use' };
      }
      reservations.set(participantId, { claimId, expiresAtMs: nowMs + claimReservationMs });
      return { outcome: 'granted' };
    },

    releaseClaim(participantId, claimId) {
      if (reservations.get(participantId)?.claimId === claimId) reservations.delete(participantId);
    },

    closeParticipantStreams(participantId, reason) {
      closeAll(participantId, reason);
    },

    shutdown() {
      isShutDown = true;
      for (const participantId of Array.from(presenceMap.keys())) {
        closeAll(participantId, 'shutdown');
      }
    },

    __streamCount(participantId) {
      return presenceMap.get(participantId)?.subscriberByConnection.size ?? 0;
    },
  };
}
