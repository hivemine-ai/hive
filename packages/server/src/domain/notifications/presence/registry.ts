// Presence Registry — in-memory map participantId → connectionId → ActiveSubscriber.
// Per the tech spec § "presence/registry.ts": single source of truth for "who is
// online" inside this Node process; consumed by the Waggle pipeline (push vs
// no-op) and by future MCP tools (`get_agent_status`).
//
// Concurrency: Node's event loop serializes Map mutations; no locks needed.
// `forEachSubscriber` snapshots the value array before iterating so a listener
// that triggers `unsubscribe` mid-iteration does not corrupt the loop.
//
// Lifecycle hardening (Slice 2 — per ADR-012):
//   - TTL passive: a periodic sweep (`setInterval`) evicts entries whose
//     `lastSeenAt` is older than `idleTimeoutMs`. Disabled when
//     `idleTimeoutMs` is null/0 (backwards-compat with Slice 0).
//   - LRU eviction at cap-hit: when `subscribe` would reject for cap, the
//     oldest entry is evicted if it meets `lruEvictThresholdMs` — otherwise
//     reject with `too_many_sessions` (preserving Slice 0 behavior).
//   - `forEachSubscriber` post-success updates `lastSeenAt` so an active
//     receiver of Waggle deliveries does not get evicted.
//   - `shutdown()` clears the sweep interval — required for graceful stop
//     and for tests to avoid timer leaks.

import { v7 as uuidv7 } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';
import { warnSweepMisconfig } from '#observability/config-guard.js';
import type { Logger } from '#observability/logger.js';

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
  /**
   * Idle threshold for the periodic sweep. If `now − lastSeenAt ≥ idleTimeoutMs`
   * the entry is evicted. Null/0 disables the sweep (backwards-compat with
   * Slice 0). No default — composition factory decides.
   */
  idleTimeoutMs?: number | null;
  /**
   * Period of the sweep timer. Only honored when `idleTimeoutMs > 0`. No
   * default — composition factory decides.
   */
  sweepIntervalMs?: number;
  /**
   * LRU eviction threshold at cap-hit. When the cap is reached and a new
   * subscribe arrives, the entry with the oldest `lastSeenAt` is evicted iff
   * `now − oldest.lastSeenAt ≥ lruEvictThresholdMs`. Null/0 disables LRU
   * eviction (cap-hit always rejects).
   */
  lruEvictThresholdMs?: number | null;
  /**
   * Deprecated alias for `idleTimeoutMs`. If both are set, `idleTimeoutMs`
   * wins; if only `heartbeatTimeoutMs` is set, it is forwarded with a
   * deprecation warning. Will be removed in a future release.
   */
  heartbeatTimeoutMs?: number | null;
  /** Hook fired AFTER a successful subscribe — composition wires the replay scheduler here. */
  onSubscribed?: (input: SubscribedHookInput) => void;
  /**
   * Clock factory. Defaults to `() => new Date()`. Tests inject a controlled
   * clock so the sweep + LRU thresholds are deterministic without real timers.
   */
  now?: () => Date;
  /**
   * Logger for eviction events and deprecation warnings. Optional — without
   * a logger the registry is silent (suitable for unit tests not asserting
   * on logs). Composition root passes the application logger.
   */
  logger?: Logger;
}

export interface PresenceRegistry {
  /** Returns a Promise per the cross-spec API; the body is sync (Map insert + hook). */
  subscribe(input: SubscribeInput): Promise<Subscription>;
  /** Idempotent. Removes the entry by `subscriptionId` (lookup O(n) per participant; n ≤ cap). */
  unsubscribe(subscriptionId: UUIDv7, participantId: UUIDv7): void;
  /** Pure read — no mutation. Used by the pipeline online/offline gate. */
  getPresence(participantId: UUIDv7): PresenceSnapshot;
  /** Snapshot-then-iterate fan-out. Sequential `await` per handle; errors thrown
   *  by `fn` are caught inside and reported via the optional sink. Touches
   *  `lastSeenAt` on each handle for which `fn` resolved without throwing. */
  forEachSubscriber(
    participantId: UUIDv7,
    fn: (handle: SubscriberHandle) => Promise<void>,
    onError?: (handle: SubscriberHandle, err: unknown) => void,
  ): Promise<void>;
  /**
   * Updates `lastSeenAt` for the matching subscription. No-op when neither
   * `idleTimeoutMs` nor `heartbeatTimeoutMs` is configured.
   */
  touch(subscriptionId: UUIDv7, participantId: UUIDv7): void;
  /**
   * Stops the periodic sweep timer. Idempotent. MUST be called by the
   * composition root on graceful stop and by tests in their teardown.
   */
  shutdown(): void;
  /** Test helper — exposes the live count for a participant. Internal-only. */
  __sessionCount(participantId: UUIDv7): number;
  /**
   * Test helper — runs the sweep synchronously against an explicit `now`.
   * Production code never calls this; the periodic timer drives the sweep.
   */
  __sweepStale(now: Date): void;
}

const DEFAULT_MAX_SESSIONS = 16;

export function createPresenceRegistry(config: PresenceRegistryConfig = {}): PresenceRegistry {
  const presenceMap = new Map<UUIDv7, ParticipantPresence>();
  const maxSessions = config.maxSessionsPerParticipant ?? DEFAULT_MAX_SESSIONS;
  const now = config.now ?? ((): Date => new Date());
  const logger = config.logger;

  // Resolve idleTimeoutMs with `heartbeatTimeoutMs` as deprecated alias.
  // Precedence: idleTimeoutMs > heartbeatTimeoutMs. If only the legacy field
  // is set, log a one-shot deprecation warning.
  let idleTimeoutMs: number | null;
  if (config.idleTimeoutMs !== undefined) {
    idleTimeoutMs = config.idleTimeoutMs;
  } else if (config.heartbeatTimeoutMs !== undefined) {
    idleTimeoutMs = config.heartbeatTimeoutMs;
    if (idleTimeoutMs !== null && idleTimeoutMs > 0 && logger !== undefined) {
      logger.warn(
        { event: 'presence_heartbeat_timeout_ms_deprecated' },
        'PresenceRegistryConfig.heartbeatTimeoutMs is deprecated; use idleTimeoutMs',
      );
    }
  } else {
    idleTimeoutMs = null;
  }

  const sweepIntervalMs = config.sweepIntervalMs ?? 0;
  const lruEvictThresholdMs = config.lruEvictThresholdMs ?? null;

  // Closes N2 of PRY-017: surface a misconfiguration where the idle
  // threshold is enabled but no sweep timer would mount. Without this guard
  // the sweep silently never runs and idle sessions accumulate — the very
  // pathology that drove INC-2026-003.
  if (logger !== undefined) {
    warnSweepMisconfig(logger, 'PresenceRegistry', {
      enabledMs: idleTimeoutMs,
      intervalMs: sweepIntervalMs,
    });
  }

  function getOrCreate(participantId: UUIDv7): ParticipantPresence {
    let entry = presenceMap.get(participantId);
    if (!entry) {
      entry = { subscriberByConnection: new Map() };
      presenceMap.set(participantId, entry);
    }
    return entry;
  }

  // Module-private closure form so the returned object's methods don't depend
  // on `this` binding. Callers that destructure (`const { subscribe } = reg;`)
  // would otherwise hit `Cannot read properties of undefined`.
  function unsubscribeImpl(subscriptionId: UUIDv7, participantId: UUIDv7): void {
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
  }

  function sweepStale(snapshotNow: Date): void {
    if (idleTimeoutMs === null || idleTimeoutMs <= 0) return;
    const cutoff = snapshotNow.getTime() - idleTimeoutMs;
    // Snapshot of (participantId, subscriber) tuples so that mutations during
    // unsubscribe do not corrupt iteration.
    const toEvict: Array<{
      participantId: UUIDv7;
      subscriptionId: UUIDv7;
      lastSeenAt: Date;
    }> = [];
    for (const [participantId, presence] of presenceMap) {
      for (const sub of presence.subscriberByConnection.values()) {
        if (sub.lastSeenAt.getTime() <= cutoff) {
          toEvict.push({
            participantId,
            subscriptionId: sub.subscriptionId,
            lastSeenAt: sub.lastSeenAt,
          });
        }
      }
    }
    for (const entry of toEvict) {
      unsubscribeImpl(entry.subscriptionId, entry.participantId);
      logger?.info(
        {
          event: 'presence_session_evicted_idle',
          participantId: entry.participantId,
          subscriptionId: entry.subscriptionId,
          lastSeenAt: entry.lastSeenAt.toISOString(),
          idleTimeoutMs,
        },
        'presence session evicted by idle sweep',
      );
    }
  }

  // Install the periodic sweep when both knobs are configured. A null/0 on
  // either knob keeps the registry in Slice 0 mode (no auto-eviction).
  let sweepTimer: NodeJS.Timeout | null = null;
  if (idleTimeoutMs !== null && idleTimeoutMs > 0 && sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      try {
        sweepStale(now());
      } catch (err) {
        // Defensive: a thrown error inside an interval callback would surface
        // as `unhandledException` in Node — guard it.
        logger?.error(
          {
            event: 'presence_sweep_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'presence sweep iteration failed',
        );
      }
    }, sweepIntervalMs);
    // The sweep is a janitor, not a critical path. Don't keep the event loop
    // alive when the only pending work is the next sweep tick.
    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
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
        // Try LRU eviction before rejecting. The oldest entry by lastSeenAt
        // is evicted iff it meets `lruEvictThresholdMs`; otherwise the new
        // subscribe is rejected as in Slice 0.
        const evicted = tryLruEvict(participantId, presence);
        if (!evicted) {
          return Promise.reject(
            new WaggleError('INVALID_INPUT', {
              subCode: 'too_many_sessions',
              message: `Participant has reached the cap of ${String(maxSessions)} simultaneous sessions`,
            }),
          );
        }
      }

      const subscriptionId = uuidv7();
      const tNow = now();
      const entry: ActiveSubscriber = {
        subscriptionId,
        handle: input.handle,
        subscribedAt: tNow,
        lastSeenAt: tNow,
      };
      presence.subscriberByConnection.set(input.handle.connectionId, entry);

      const close = (): void => {
        unsubscribeImpl(subscriptionId, participantId);
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

      logger?.info(
        {
          event: 'presence_subscribe_success',
          participantId,
          subscriptionId,
          connectionId: input.handle.connectionId,
        },
        'presence subscribe success',
      );

      const subscription: Subscription = {
        id: subscriptionId,
        participantId,
        subscribedAt: tNow,
        close,
      };
      return Promise.resolve(subscription);
    },

    unsubscribe: unsubscribeImpl,

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
      // Snapshot the (handle, subscriber) pairs before iterating — `fn` may
      // trigger `unsubscribe` (e.g. a zombie handle's deliver throws → handle
      // invokes onClose) and mutating the Map mid-iteration would skip
      // entries. We carry the subscriber reference so a successful deliver
      // can update its `lastSeenAt` without a second lookup.
      const pairs: Array<{ handle: SubscriberHandle; sub: ActiveSubscriber }> = [];
      for (const sub of presence.subscriberByConnection.values()) {
        pairs.push({ handle: sub.handle, sub });
      }
      for (const { handle, sub } of pairs) {
        try {
          await fn(handle);
          // Post-success: refresh `lastSeenAt` so a client that only receives
          // pushes (no tool calls) is not evicted by the idle sweep.
          sub.lastSeenAt = now();
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
      // Touch is a no-op when neither knob is set — preserves Slice 0
      // semantics for callers that don't run the sweep.
      if (idleTimeoutMs === null || idleTimeoutMs <= 0) return;
      const presence = presenceMap.get(participantId);
      if (!presence) return;
      for (const sub of presence.subscriberByConnection.values()) {
        if (sub.subscriptionId === subscriptionId) {
          sub.lastSeenAt = now();
          return;
        }
      }
    },

    shutdown() {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },

    __sessionCount(participantId) {
      return presenceMap.get(participantId)?.subscriberByConnection.size ?? 0;
    },

    __sweepStale(snapshotNow) {
      sweepStale(snapshotNow);
    },
  };

  /**
   * Attempts LRU eviction on cap-hit. Returns true iff an entry was evicted
   * (caller can proceed with the new subscribe). Returns false when no entry
   * is old enough — caller must reject with `too_many_sessions`.
   */
  function tryLruEvict(participantId: UUIDv7, presence: ParticipantPresence): boolean {
    if (lruEvictThresholdMs === null || lruEvictThresholdMs <= 0) return false;
    let oldest: ActiveSubscriber | null = null;
    for (const sub of presence.subscriberByConnection.values()) {
      if (oldest === null || sub.lastSeenAt.getTime() < oldest.lastSeenAt.getTime()) {
        oldest = sub;
      }
    }
    if (oldest === null) return false;
    const idleMs = now().getTime() - oldest.lastSeenAt.getTime();
    if (idleMs < lruEvictThresholdMs) return false;
    const evictedId = oldest.subscriptionId;
    const evictedLastSeenAt = oldest.lastSeenAt;
    unsubscribeImpl(evictedId, participantId);
    logger?.info(
      {
        event: 'presence_session_evicted_lru',
        participantId,
        subscriptionId: evictedId,
        lastSeenAt: evictedLastSeenAt.toISOString(),
        idleMs,
        lruEvictThresholdMs,
      },
      'presence session evicted by LRU at cap-hit',
    );
    return true;
  }
}
