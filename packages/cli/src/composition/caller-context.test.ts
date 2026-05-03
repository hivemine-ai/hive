import { describe, expect, it } from 'vitest';

import type { CliRuntime } from '@hive/server';

import { getCliCallerContext } from './caller-context.js';

// Project the CliRuntime fields we need into a partial — we never exercise the
// repo / DB methods in this unit test, so casting via `unknown` is safe and
// avoids pulling in heavyweight stubs.
function makeRuntime(overrides?: Partial<CliRuntime>): CliRuntime {
  const base = {
    hiveStableIdentifier: '019de8c4-b3c3-7279-a2ee-09424384da11',
    hiveName: 'test-hive',
    ...overrides,
  };
  return base as unknown as CliRuntime;
}

describe('getCliCallerContext', () => {
  it('projects hiveId + hiveName from the runtime', () => {
    const runtime = makeRuntime();
    const ctx = getCliCallerContext(runtime);
    expect(ctx).toEqual({
      hiveId: '019de8c4-b3c3-7279-a2ee-09424384da11',
      hiveName: 'test-hive',
    });
  });

  it('preserves the exact hiveName casing — used as the suffix in parseReference', () => {
    const runtime = makeRuntime({ hiveName: 'Cotalker.io' });
    const ctx = getCliCallerContext(runtime);
    expect(ctx.hiveName).toBe('Cotalker.io');
  });

  it('returns a distinct object per call (no mutable shared state)', () => {
    const runtime = makeRuntime();
    const a = getCliCallerContext(runtime);
    const b = getCliCallerContext(runtime);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
