import { describe, expect, it } from 'vitest';

import { HIVE_DEFAULT_HTTP_HOST, HIVE_DEFAULT_HTTP_PORT } from './network.js';

describe('@hive/shared network defaults', () => {
  it('exposes loopback as the default HTTP host', () => {
    expect(HIVE_DEFAULT_HTTP_HOST).toBe('127.0.0.1');
  });

  it('exposes 8443 as the default HTTP port', () => {
    // Sentinel: the CLI banner, the wire bind, and the http-host all derive
    // from the same constant. If anyone edits this value, every consumer
    // must be re-verified — the regression test in cli/serve.test.ts +
    // server/wire.test.ts pin the chain on the read side.
    expect(HIVE_DEFAULT_HTTP_PORT).toBe(8443);
  });

  it('keeps the host as a string and the port as a number', () => {
    expect(typeof HIVE_DEFAULT_HTTP_HOST).toBe('string');
    expect(typeof HIVE_DEFAULT_HTTP_PORT).toBe('number');
    expect(Number.isInteger(HIVE_DEFAULT_HTTP_PORT)).toBe(true);
  });
});
