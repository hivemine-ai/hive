#!/usr/bin/env node
/* eslint-env node */
// Standalone MCP smoke client used by .github/workflows/smoke.yml and the
// `H7 — smoke E2E local` checklist of PRY-008. It talks plain HTTP to the MCP
// endpoint on revision 2026-07-28 (no SDK dependency, no session handshake).
//
// Usage:
//   node deployment/smoke-mcp-client.mjs <baseUrl> <jwt> <expectedParticipantId>
//
// Exits 0 when:
//   1. `server/discover` answers 200 and lists 2026-07-28 as a supported version.
//   2. `tools/call get_agent_config` returns participant_id === expected.
//   3. `tools/call send_message` to self succeeds, so the run leaves an audit row.
//
// Exits 1 with a diagnostic on stderr otherwise.

import { PROTOCOL_VERSION, envelope, rpc } from './mcp-wire.mjs';

const [, , baseUrl, jwt, expectedParticipantId] = process.argv;
if (!baseUrl || !jwt || !expectedParticipantId) {
  console.error('usage: smoke-mcp-client.mjs <baseUrl> <jwt> <expectedParticipantId>');
  process.exit(2);
}

const url = `${baseUrl}/mcp`;

function fail(msg, extra) {
  console.error(`smoke-mcp-client: FAIL — ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

async function callTool(id, name, args) {
  const res = await rpc({
    url,
    jwt,
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: envelope() },
  });
  if (res.status !== 200) fail(`tools/call ${name} returned status ${res.status}`, res.body);
  if (!res.body || res.body.error) fail(`tools/call ${name} returned an error`, res.body);
  const result = res.body.result;
  if (result?.isError) fail(`tools/call ${name} reported isError`, result);
  const text = result?.content?.find((c) => c.type === 'text');
  if (!text) fail(`tools/call ${name} result has no text content`, result);
  try {
    return JSON.parse(text.text);
  } catch (err) {
    fail(`tools/call ${name} text content is not JSON: ${err.message}`, text);
  }
}

async function main() {
  // ── 1. server/discover ──
  const discover = await rpc({
    url,
    jwt,
    method: 'server/discover',
    params: { _meta: envelope() },
  });
  if (discover.status !== 200) fail(`server/discover returned status ${discover.status}`, discover);
  if (!discover.body || discover.body.error)
    fail('server/discover returned an error', discover.body);
  const supported = discover.body.result?.supportedVersions;
  if (!Array.isArray(supported) || !supported.includes(PROTOCOL_VERSION)) {
    fail(`server/discover does not list ${PROTOCOL_VERSION}`, discover.body.result);
  }
  if (discover.headers.get('mcp-session-id')) {
    fail('server answered with an mcp-session-id header; the revision has no sessions');
  }
  console.log(`smoke-mcp-client: server/discover ok (supportedVersions=${supported.join(',')})`);

  // ── 2. tools/call get_agent_config ──
  const config = await callTool(2, 'get_agent_config', {});
  // The wire shape is snake_case, per the `API MCP — Tools` tech spec.
  if (config.participant_id !== expectedParticipantId) {
    fail(
      `participant_id mismatch — expected ${expectedParticipantId}, got ${config.participant_id}`,
      config,
    );
  }
  console.log(`smoke-mcp-client: get_agent_config ok (participant_id=${config.participant_id})`);

  // ── 3. tools/call send_message (to self) ──
  const sent = await callTool(3, 'send_message', {
    recipient: expectedParticipantId,
    type: 'notification',
    body: 'deployment smoke',
  });
  if (typeof sent.message_id !== 'string') fail('send_message returned no message_id', sent);
  console.log(`smoke-mcp-client: send_message ok (message_id=${sent.message_id})`);

  console.log('smoke-mcp-client: PASS');
}

main().catch((err) => {
  console.error(`smoke-mcp-client: unhandled error — ${err.stack ?? err.message}`);
  process.exit(1);
});
