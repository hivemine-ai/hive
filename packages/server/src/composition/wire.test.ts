// Unit tests for `stopWithDrainTimeout` — the drain-with-timeout primitive
// underlying `wire.stop()`. The most important invariant validated here is
// the F7 carry-over from PRY-006: a slow `httpHost.stop()` that rejects
// AFTER the race already returned by timeout MUST NOT escape as
// `unhandledRejection` (default Node policy crashes the process in prod).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveWireConfigFromEnv,
  stopWithDrainTimeout,
  warnIfAllowedHostsEmpty,
  warnIfStdoutConsumerMissing,
} from './wire.js';

describe('stopWithDrainTimeout', () => {
  let unhandledHandler: (reason: unknown) => void;
  const unhandledRejections: unknown[] = [];

  beforeEach(() => {
    unhandledRejections.length = 0;
    unhandledHandler = (reason) => unhandledRejections.push(reason);
    process.on('unhandledRejection', unhandledHandler);
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandledHandler);
  });

  it('completes silently when innerStop resolves before timeout', async () => {
    const onError = vi.fn();
    await stopWithDrainTimeout(Promise.resolve(), 1000, onError);
    expect(onError).not.toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it('forwards in-race reject to onError when innerStop rejects before timeout', async () => {
    const onError = vi.fn();
    const innerStop = Promise.reject(new Error('immediate stop fail'));

    await stopWithDrainTimeout(innerStop, 1000, onError);

    expect(onError).toHaveBeenCalledTimes(1);
    const reportedErr: unknown = onError.mock.calls[0]?.[0];
    expect(reportedErr).toBeInstanceOf(Error);
    expect((reportedErr as Error).message).toBe('immediate stop fail');

    // Settle any pending microtasks before we assert no unhandledRejection.
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledRejections).toHaveLength(0);
  });

  it('returns when timeout wins over slow innerStop, without calling onError yet', async () => {
    const onError = vi.fn();
    let resolveStop!: () => void;
    const innerStop = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    await stopWithDrainTimeout(innerStop, 30, onError);

    // Race won by timeout — onError NOT called (innerStop hasn't settled).
    expect(onError).not.toHaveBeenCalled();

    // Cleanup: resolve the dangling promise so test process is clean.
    resolveStop();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledRejections).toHaveLength(0);
  });

  // F7 carry-over from PRY-006 — the headline invariant of this fix.
  it('absorbs post-timeout rejection without raising unhandledRejection', async () => {
    const onError = vi.fn();
    let rejectStop!: (err: Error) => void;
    const innerStop = new Promise<void>((_, reject) => {
      rejectStop = reject;
    });

    // Race wins by timeout (drainMs=30 << time before rejectStop fires).
    await stopWithDrainTimeout(innerStop, 30, onError);
    expect(onError).not.toHaveBeenCalled();

    // Now innerStop rejects — AFTER the race already returned by timeout.
    // Without the silent catch in stopWithDrainTimeout, this rejection would
    // escape Node's microtask machinery as `unhandledRejection`. With the
    // fix, it is absorbed silently.
    rejectStop(new Error('socket lingering on slow shutdown'));

    // Allow microtasks + a few ticks to flush so unhandledRejection would
    // surface if it were going to.
    await new Promise((r) => setTimeout(r, 50));

    expect(unhandledRejections).toHaveLength(0);
    // Post-race reject is silently absorbed — onError is NOT invoked for it
    // (it would have been logged as in-race; here it's a noop).
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not double-invoke onError when innerStop resolves after timeout', async () => {
    const onError = vi.fn();
    let resolveStop!: () => void;
    const innerStop = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    await stopWithDrainTimeout(innerStop, 30, onError);
    expect(onError).not.toHaveBeenCalled();

    resolveStop();
    await new Promise((r) => setTimeout(r, 50));

    expect(onError).not.toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });
});

describe('warnIfStdoutConsumerMissing (AC8)', () => {
  it('emits warn when stdout.writableEnded === true', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfStdoutConsumerMissing>[0];
    warnIfStdoutConsumerMissing(logger, { writableEnded: true, destroyed: false });

    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0]!;
    const fields = call[0] as Record<string, unknown>;
    expect(fields['event']).toBe('stdout_consumer_missing');
    expect(fields['writableEnded']).toBe(true);
    expect(fields['destroyed']).toBe(false);
  });

  it('emits warn when stdout.destroyed === true', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfStdoutConsumerMissing>[0];
    warnIfStdoutConsumerMissing(logger, { writableEnded: false, destroyed: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields['event']).toBe('stdout_consumer_missing');
    expect(fields['destroyed']).toBe(true);
  });

  it('emits warn when both writableEnded and destroyed are true', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfStdoutConsumerMissing>[0];
    warnIfStdoutConsumerMissing(logger, { writableEnded: true, destroyed: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit warn when stdout is healthy (both false)', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfStdoutConsumerMissing>[0];
    warnIfStdoutConsumerMissing(logger, { writableEnded: false, destroyed: false });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveWireConfigFromEnv — listen', () => {
  it('uses the provisional defaults', () => {
    expect(resolveWireConfigFromEnv({})).toMatchObject({
      listenKeepAliveIntervalMs: 15_000,
      listenStallTimeoutMs: 30_000,
      reverifyIntervalSeconds: 60,
      maxUnreadPerSender: 500,
    });
  });

  it('rejects a keep-alive interval that hivectl watch would read as silence', () => {
    expect(() => resolveWireConfigFromEnv({ HIVE_LISTEN_KEEPALIVE_INTERVAL_MS: '45000' })).toThrow(
      /HIVE_LISTEN_KEEPALIVE_INTERVAL_MS/,
    );
    expect(
      resolveWireConfigFromEnv({ HIVE_LISTEN_KEEPALIVE_INTERVAL_MS: '44999' })
        .listenKeepAliveIntervalMs,
    ).toBe(44_999);
  });

  it('fails at boot when the stall timeout does not beat the 45 s of hivectl watch', () => {
    expect(() => resolveWireConfigFromEnv({ HIVE_LISTEN_STALL_TIMEOUT_MS: '45000' })).toThrow(
      /HIVE_LISTEN_STALL_TIMEOUT_MS/,
    );
    expect(
      resolveWireConfigFromEnv({ HIVE_LISTEN_STALL_TIMEOUT_MS: '44999' }).listenStallTimeoutMs,
    ).toBe(44_999);
  });

  it('accepts 0 to disable the periodic re-verification, and rejects a quota of 0', () => {
    expect(
      resolveWireConfigFromEnv({ HIVE_MCP_REVERIFY_INTERVAL_SECONDS: '0' }).reverifyIntervalSeconds,
    ).toBe(0);
    expect(() => resolveWireConfigFromEnv({ HIVE_CELL_MAX_UNREAD_PER_SENDER: '0' })).toThrow();
  });
});

describe('warnIfAllowedHostsEmpty (PRY-085)', () => {
  it('emits one structured warn when the allow-list is empty', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfAllowedHostsEmpty>[0];
    warnIfAllowedHostsEmpty(logger, []);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]! as [Record<string, unknown>, string];
    expect(fields['event']).toBe('allowed_hosts_empty');
    expect(fields['envVar']).toBe('HIVE_MCP_ALLOWED_HOSTS');
    expect(message).toContain('HIVE_MCP_ALLOWED_HOSTS');
    expect(message).toContain('Host header is not validated');
  });

  it('does not warn when the allow-list has entries', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof warnIfAllowedHostsEmpty>[0];
    warnIfAllowedHostsEmpty(logger, ['hive.example.com']);

    expect(warn).not.toHaveBeenCalled();
  });
});
