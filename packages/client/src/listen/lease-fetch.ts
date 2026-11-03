// Opt-in listen lease. The server cannot see a silent network cut on its own: the kernel
// keeps accepting its keep-alives. So the client asks for a lease on the listen request
// (`Hive-Listen-Lease: <key>`) and, only if the server grants one (`Hive-Listen-Lease-Ms`),
// renews it with `server/discover` carrying the same key. A lease that runs out ends the
// stream on the server, which then reports the participant offline.
//
// The key rides only on the listen and on the renewals, never on the version probe or
// on any other request.

import { randomBytes } from 'node:crypto';

import type { FetchLike } from './liveness-fetch.js';

export const LEASE_REQUEST_HEADER = 'hive-listen-lease';
export const LEASE_RESPONSE_HEADER = 'hive-listen-lease-ms';

const LISTEN_METHOD = 'subscriptions/listen';
const DISCOVER_METHOD = 'server/discover';
const BEATS_PER_LEASE = 4;
const MIN_BEAT_MS = 100;

export interface Lease {
  /** Random per connection, 128 bits. */
  readonly key: string;
  /** Granted by the server on the listen response; null until then, or if never. */
  leaseMs: number | null;
}

export function createLease(): Lease {
  return { key: randomBytes(16).toString('base64url'), leaseMs: null };
}

/** Three renewals can be lost before the lease runs out. */
export function beatIntervalMs(leaseMs: number): number {
  return Math.max(MIN_BEAT_MS, Math.floor(leaseMs / BEATS_PER_LEASE));
}

function rpcMethod(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const method = (JSON.parse(body) as { method?: unknown } | null)?.method;
    return typeof method === 'string' ? method : undefined;
  } catch {
    return undefined;
  }
}

function parseLeaseMs(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function leaseFetch(base: FetchLike, lease: Lease): FetchLike {
  return async (input, init) => {
    const method = rpcMethod(init?.body);
    const isListen = method === LISTEN_METHOD;
    const isRenewal = method === DISCOVER_METHOD && lease.leaseMs !== null;
    if (!isListen && !isRenewal) return base(input, init);

    const headers = new Headers(init?.headers);
    headers.set(LEASE_REQUEST_HEADER, lease.key);
    const res = await base(input, { ...init, headers });
    if (isListen) lease.leaseMs = parseLeaseMs(res.headers.get(LEASE_RESPONSE_HEADER));
    return res;
  };
}
