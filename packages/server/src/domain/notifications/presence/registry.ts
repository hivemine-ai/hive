// Presence Registry — in-memory map participantId → connectionId → ActiveSubscriber.
// Per the tech spec § "presence/registry.ts": single source of truth for "who is
// online" inside this Node process; consumed by the Waggle pipeline (push vs
// no-op) and by future MCP tools (`get_agent_status`).
//
// Concurrency: Node's event loop serializes Map mutations; no locks needed.
// `forEachSubscriber` snapshots the value array before iterating so a listener
// that triggers `unsubscribe` mid-iteration does not corrupt the loop.

import { v7 as uuidv7 } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';

import { WaggleError } from '../errors.js';

import type { SubscriberHandle } from './subscriber-handle.js';
import type { PresenceSnapshot, SubscribeInput, Subscription } from './types.js';

interface ActiveSubscriber {
  subscriptionId: UUIDv7;
  handle: SubscriberHandle;
  subscribedAt: Date;
  lastSeenAt: Date;
}

interface ParticipantPresence {
  subscriberByConnection: Map<UUIDv7, ActiveSubscriber>;
}

/** Hook payload fired AFTER a successful subscribe. Used by composition root
 *  to wire `replay.scheduleReplayFor` without coupling registry → replay. */
export interface SubscribedHookInput {
  participantId: UUIDv7;
  subscriptionId: UUIDv7;
  handle: SubscriberHandle;
}

export interface PresenceRegistryConfig {
  /** Cap of simultaneous sessions per participant. Default 16. */
  maxSessionsPerParticipant?: number;
  /** If > 0, enables `touch` heartbeat tracking. null/0 = touch is no-op. Default null. */
  heartbeatTimeoutMs?: number | null;
  /** Hook fired AFTER a successful subscribe — composition wires the replay scheduler here. */
  onSubscribed?: (input: SubscribedHookInput) => void;
}

export interface PresenceRegistry {
  /** Returns a Promise per the cross-spec API; the body is sync (Map insert + hook). */
  subscribe(input: SubscribeInput): Promise<Subscription>;
  /** Idempotent. Removes the entry by `subscriptionId` (lookup O(n) per participant; n ≤ cap). */
  unsubscribe(subscriptionId: UUIDv7, participantId: UUIDv7): void;
  /** Pure read — no mutation. Used by the pipeline online/offline gate. */
  getPresence(participantId: UUIDv7): PresenceSnapshot;
  /** Snapshot-then-iterate fan-out. Sequential `await` per handle; errors thrown
   *  by `fn` are caught inside and reported via the optional sink. */
  forEachSubscriber(
    participantId: UUIDv7,
    fn: (handle: SubscriberHandle) => Promise<void>,
    onError?: (handle: SubscriberHandle, err: unknown) => void,
  ): Promise<void>;
  /** No-op when heartbeat is disabled. Otherwise updates `lastSeenAt`. */
  touch(subscriptionId: UUIDv7, participantId: UUIDv7): void;
  /** Test helper — exposes the live count for a participant. Internal-only. */
  __sessionCount(participantId: UUIDv7): number;
}

const DEFAULT_MAX_SESSIONS = 16;

export function createPresenceRegistry(config: PresenceRegistryConfig = {}): PresenceRegistry {
  const presenceMap = new Map<UUIDv7, ParticipantPresence>();
  const maxSessions = config.maxSessionsPerParticipant ?? DEFAULT_MAX_SESSIONS;
  const heartbeatEnabled =
    (config.heartbeatTimeoutMs ?? null) !== null && config.heartbeatTimeoutMs! > 0;

  function getOrCreate(participantId: UUIDv7): ParticipantPresence {
    let entry = presenceMap.get(participantId);
    if (!entry) {
      entry = { subscriberByConnection: new Map() };
      presenceMap.set(participantId, entry);
    }
    return entry;
  }

  return {
    subscribe(input) {
      // Defense-in-depth: the verifier already enforces state==='active' (Auth
      // step 7), but tests and internal callers may bypass it. The check is a
      // single property read — cheap.
      if (input.callerContext.current.state !== 'active') {
        return Promise.reject(
          new WaggleError('PARTICIPANT_NOT_ACTIVE_FOR_SUBSCRIBE', {
            subCode: input.callerContext.current.state,
            message: 'Participant is not active; subscribe rejected',
          }),
        );
      }

      const participantId = input.callerContext.participantId;
      const presence = getOrCreate(participantId);

      if (presence.subscriberByConnection.size >= maxSessions) {
        return Promise.reject(
          new WaggleError('INVALID_INPUT', {
            subCode: 'too_many_sessions',
            message: `Participant has reached the cap of ${String(maxSessions)} simultaneous sessions`,
          }),
        );
      }

      const subscriptionId = uuidv7();
      const now = new Date();
      const entry: ActiveSubscriber = {
        subscriptionId,
        handle: input.handle,
        subscribedAt: now,
        lastSeenAt: now,
      };
      presence.subscriberByConnection.set(input.handle.connectionId, entry);

      const close = (): void => {
        this.unsubscribe(subscriptionId, participantId);
      };
      // The handle wires its own close detection (socket dead → invoke this).
      input.handle.onClose(close);

      // Fire the post-subscribe hook AFTER the registry mutation but BEFORE
      // returning. Composition wires `replay.scheduleReplayFor` here so the
      // replay is queued for the next tick (setImmediate), not blocking us.
      try {
        config.onSubscribed?.({ participantId, subscriptionId, handle: input.handle });
      } catch {
        // Swallow — subscribe MUST NOT fail because of a hook bug. If the
        // composition wired something that throws, we still return the
        // subscription; the client can use polling fallbacks.
      }

      const subscription: Subscription = {
        id: subscriptionId,
        participantId,
        subscribedAt: now,
        close,
      };
      return Promise.resolve(subscription);
    },

    unsubscribe(subscriptionId, participantId) {
      const presence = presenceMap.get(participantId);
      if (!presence) return;
      // Lookup by subscriptionId — O(n) where n ≤ cap (default 16).
      let matchedConnectionId: UUIDv7 | undefined;
      for (const [connectionId, sub] of presence.subscriberByConnection) {
        if (sub.subscriptionId === subscriptionId) {
          matchedConnectionId = connectionId;
          break;
        }
      }
      if (matchedConnectionId === undefined) return;
      presence.subscriberByConnection.delete(matchedConnectionId);
      if (presence.subscriberByConnection.size === 0) {
        presenceMap.delete(participantId);
      }
    },

    getPresence(participantId) {
      const presence = presenceMap.get(participantId);
      if (!presence || presence.subscriberByConnection.size === 0) {
        return { online: false, sessionCount: 0, sessionsSubscribedAt: [] };
      }
      const subscribedAts: Date[] = [];
      for (const sub of presence.subscriberByConnection.values()) {
        subscribedAts.push(sub.subscribedAt);
      }
      return {
        online: true,
        sessionCount: subscribedAts.length,
        sessionsSubscribedAt: subscribedAts,
      };
    },

    async forEachSubscriber(participantId, fn, onError) {
      const presence = presenceMap.get(participantId);
      if (!presence || presence.subscriberByConnection.size === 0) return;
      // Snapshot the handles before iterating — `fn` may trigger `unsubscribe`
      // (e.g. a zombie handle's deliver throws → handle invokes onClose) and
      // mutating the Map mid-iteration would skip entries.
      const handles: SubscriberHandle[] = [];
      for (const sub of presence.subscriberByConnection.values()) {
        handles.push(sub.handle);
      }
      for (const handle of handles) {
        try {
          await fn(handle);
        } catch (err) {
          // Per the tech spec: error-isolated by handle. One zombie does not
          // block the rest of the fan-out.
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

    touch(subscriptionId, participantId) {
      if (!heartbeatEnabled) return;
      const presence = presenceMap.get(participantId);
      if (!presence) return;
      for (const sub of presence.subscriberByConnection.values()) {
        if (sub.subscriptionId === subscriptionId) {
          sub.lastSeenAt = new Date();
          return;
        }
      }
    },

    __sessionCount(participantId) {
      return presenceMap.get(participantId)?.subscriberByConnection.size ?? 0;
    },
  };
}
