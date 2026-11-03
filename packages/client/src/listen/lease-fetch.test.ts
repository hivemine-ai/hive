import { describe, expect, it } from 'vitest';

import { beatIntervalMs, createLease, leaseFetch } from './lease-fetch.js';
import type { FetchLike } from './liveness-fetch.js';

interface Seen {
  method: string;
  key: string | null;
}

function recorder(responseHeaders: Record<string, string> = {}): {
  base: FetchLike;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const base: FetchLike = (_input, init) => {
    const body = JSON.parse(init?.body as string) as { method: string };
    seen.push({ method: body.method, key: new Headers(init?.headers).get('hive-listen-lease') });
    const isListen = body.method === 'subscriptions/listen';
    return Promise.resolve(
      new Response('', { status: 200, headers: isListen ? responseHeaders : {} }),
    );
  };
  return { base, seen };
}

function rpc(method: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer t', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  };
}

describe('createLease', () => {
  it('draws a fresh 128-bit base64url key every time', () => {
    const a = createLease();
    const b = createLease();
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.leaseMs).toBeNull();
  });
});

describe('leaseFetch', () => {
  it('sends the key on the listen and learns the lease the server grants', async () => {
    const { base, seen } = recorder({ 'hive-listen-lease-ms': '60000' });
    const lease = createLease();
    const fetch = leaseFetch(base, lease);

    await fetch('http://h/mcp', rpc('subscriptions/listen'));

    expect(seen).toEqual([{ method: 'subscriptions/listen', key: lease.key }]);
    expect(lease.leaseMs).toBe(60_000);
  });

  it('keeps the other headers of the request', async () => {
    let auth: string | null = null;
    const base: FetchLike = (_i, init) => {
      auth = new Headers(init?.headers).get('authorization');
      return Promise.resolve(new Response(''));
    };
    await leaseFetch(base, createLease())('http://h/mcp', rpc('subscriptions/listen'));
    expect(auth).toBe('Bearer t');
  });

  it('a server without lease support leaves the lease unset', async () => {
    const { base } = recorder();
    const lease = createLease();
    await leaseFetch(base, lease)('http://h/mcp', rpc('subscriptions/listen'));
    expect(lease.leaseMs).toBeNull();
  });

  it.each(['0', '-5', 'abc', '1.5', ''])('ignores a malformed lease header (%j)', async (value) => {
    const { base } = recorder({ 'hive-listen-lease-ms': value });
    const lease = createLease();
    await leaseFetch(base, lease)('http://h/mcp', rpc('subscriptions/listen'));
    expect(lease.leaseMs).toBeNull();
  });

  it('a discover carries the key only once a lease was granted: the probe never does', async () => {
    const { base, seen } = recorder({ 'hive-listen-lease-ms': '600' });
    const lease = createLease();
    const fetch = leaseFetch(base, lease);

    await fetch('http://h/mcp', rpc('server/discover'));
    await fetch('http://h/mcp', rpc('subscriptions/listen'));
    await fetch('http://h/mcp', rpc('server/discover'));

    expect(seen.map((s) => s.key)).toEqual([null, lease.key, lease.key]);
  });

  it('never sends the key on any other method', async () => {
    const { base, seen } = recorder({ 'hive-listen-lease-ms': '600' });
    const fetch = leaseFetch(base, createLease());
    await fetch('http://h/mcp', rpc('subscriptions/listen'));
    await fetch('http://h/mcp', rpc('resources/list'));
    await fetch('http://h/mcp', rpc('tools/call'));
    expect(seen.slice(1).map((s) => s.key)).toEqual([null, null]);
  });

  it('passes through a request whose body is not JSON-RPC', async () => {
    const base: FetchLike = () => Promise.resolve(new Response('ok'));
    const res = await leaseFetch(base, createLease())('http://h/mcp', { method: 'GET' });
    expect(await res.text()).toBe('ok');
  });
});

describe('beatIntervalMs', () => {
  it('beats four times per lease', () => {
    expect(beatIntervalMs(60_000)).toBe(15_000);
    expect(beatIntervalMs(600)).toBe(150);
  });

  it('never beats faster than the floor, whatever the server says', () => {
    expect(beatIntervalMs(4)).toBe(100);
  });
});
