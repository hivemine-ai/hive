#!/usr/bin/env node
/* eslint-env node */
// Protocol contract check for a running Hive server (ADR-024). It pins the
// decision that Hive serves MCP 2026-07-28 and nothing else, so CI fails if
// legacy support comes back or the advertised surface drifts.
//
// Usage:
//   node deployment/smoke-contract.mjs <baseUrl> <jwt>
//
// Exits 0 when every check passes; otherwise prints each failure and exits 1.

import { isDeepStrictEqual } from 'node:util';

import { PROTOCOL_VERSION, envelope, plain, rpc } from './mcp-wire.mjs';

const [, , baseUrl, jwt] = process.argv;
if (!baseUrl || !jwt) {
  console.error('usage: smoke-contract.mjs <baseUrl> <jwt>');
  process.exit(2);
}

const url = `${baseUrl}/mcp`;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`smoke-contract: ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`smoke-contract: FAIL ${name} — ${err.message}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const legacyInitialize = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'contract-check', version: '0.0.0' },
};

await check('legacy initialize without version header is rejected', async () => {
  const res = await rpc({
    url,
    jwt,
    method: 'initialize',
    params: legacyInitialize,
    headers: { 'mcp-protocol-version': null, 'mcp-method': null },
  });
  expect(res.status === 400, `expected 400, got ${res.status}`);
  expect(res.body?.error?.code === -32022, `expected -32022, got ${res.body?.error?.code}`);
  expect(!res.headers.get('mcp-session-id'), 'a rejected initialize opened a session');
});

await check('legacy protocol version header is rejected', async () => {
  const res = await rpc({
    url,
    jwt,
    method: 'tools/list',
    headers: { 'mcp-protocol-version': '2024-11-05' },
  });
  expect(res.status === 400, `expected 400, got ${res.status}`);
  expect(res.body?.error?.code === -32022, `expected -32022, got ${res.body?.error?.code}`);
});

await check('initialize under the modern header is rejected', async () => {
  const res = await rpc({ url, jwt, method: 'initialize', params: legacyInitialize });
  expect(res.status === 400, `expected 400, got ${res.status}`);
  expect(res.body?.error?.code === -32020, `expected -32020, got ${res.body?.error?.code}`);
  expect(!res.body?.result, 'initialize returned a result');
  expect(!res.headers.get('mcp-session-id'), 'a rejected initialize opened a session');
});

await check('GET /mcp answers 405', async () => {
  const res = await plain({ url, jwt, method: 'GET' });
  expect(res.status === 405, `expected 405, got ${res.status}`);
});

await check('DELETE /mcp answers 405', async () => {
  const res = await plain({ url, jwt, method: 'DELETE' });
  expect(res.status === 405, `expected 405, got ${res.status}`);
});

await check('request without a Bearer answers 401', async () => {
  const res = await rpc({ url, method: 'server/discover', params: { _meta: envelope() } });
  expect(res.status === 401, `expected 401, got ${res.status}`);
});

await check('request without the per-request envelope is rejected', async () => {
  const res = await rpc({ url, jwt, method: 'server/discover', params: {} });
  expect(res.status === 400, `expected 400, got ${res.status}`);
  expect(res.body?.error?.code === -32602, `expected -32602, got ${res.body?.error?.code}`);
});

await check('Mcp-Session-Id is ignored and never issued', async () => {
  const res = await rpc({
    url,
    jwt,
    method: 'server/discover',
    params: { _meta: envelope() },
    headers: { 'mcp-session-id': 'not-a-real-session' },
  });
  expect(res.status === 200, `expected 200, got ${res.status}`);
  expect(!res.headers.get('mcp-session-id'), 'the server issued an mcp-session-id');
});

await check('server/discover advertises exactly the 2026-07-28 surface', async () => {
  const res = await rpc({ url, jwt, method: 'server/discover', params: { _meta: envelope() } });
  expect(res.status === 200, `expected 200, got ${res.status}`);
  const result = res.body?.result;
  expect(
    isDeepStrictEqual(result?.supportedVersions, [PROTOCOL_VERSION]),
    `supportedVersions is ${JSON.stringify(result?.supportedVersions)}`,
  );
  // Declaring `prompts` without serving them, or `experimental['claude/channel']`,
  // would promise behaviour Hive does not have.
  expect(
    isDeepStrictEqual(result?.capabilities, { tools: {}, resources: { subscribe: true } }),
    `capabilities is ${JSON.stringify(result?.capabilities)}`,
  );
});

await check('tools/list serves the catalog and prompts/list is not served', async () => {
  const tools = await rpc({ url, jwt, method: 'tools/list', params: { _meta: envelope() } });
  expect(tools.status === 200, `tools/list returned ${tools.status}`);
  expect(Array.isArray(tools.body?.result?.tools), 'tools/list has no tools array');
  const prompts = await rpc({ url, jwt, method: 'prompts/list', params: { _meta: envelope() } });
  expect(
    prompts.body?.error?.code === -32601,
    `prompts/list: expected -32601, got ${prompts.body?.error?.code}`,
  );
  expect(!prompts.body?.result, 'prompts/list returned a result');
});

if (failures.length > 0) {
  console.error(`smoke-contract: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('smoke-contract: PASS');
