#!/usr/bin/env node
/* eslint-env node */
// Standalone MCP smoke client used by .github/workflows/smoke.yml + the
// `H7 — smoke E2E local` checklist of PRY-008. Talks raw HTTP + SSE to
// the MCP transport (no SDK dependency — keeps CI install footprint small).
//
// Usage:
//   node deployment/smoke-mcp-client.mjs <baseUrl> <jwt> <expectedParticipantId>
//
// Exits 0 when:
//   1. POST /mcp initialize succeeds (returns mcp-session-id, protocol version).
//   2. POST /mcp notifications/initialized completes (handshake done).
//   3. POST /mcp tools/call get_agent_config returns participantId === expected.
//
// Exits 1 with diagnostic to stderr otherwise.

const [, , baseUrl, jwt, expectedParticipantId] = process.argv;
if (!baseUrl || !jwt || !expectedParticipantId) {
  console.error('usage: smoke-mcp-client.mjs <baseUrl> <jwt> <expectedParticipantId>');
  process.exit(2);
}

const MCP_URL = `${baseUrl}/mcp`;
const PROTOCOL_VERSION = '2024-11-05';

async function rpc(body, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${jwt}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const returnedSession = res.headers.get('mcp-session-id');
  const contentType = res.headers.get('content-type') ?? '';

  if (res.status === 202 || res.status === 204) {
    await drain(res);
    return { status: res.status, body: null, sessionId: returnedSession };
  }

  if (contentType.includes('text/event-stream') && res.body) {
    const parsed = await readSseUntilId(res.body, body.id);
    return { status: res.status, body: parsed, sessionId: returnedSession };
  }

  const text = await res.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave null
    }
  }
  return { status: res.status, body: parsed, sessionId: returnedSession };
}

async function drain(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
}

async function readSseUntilId(stream, targetId, timeoutMs = 5000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(50, deadline - Date.now());
      const next = await Promise.race([
        reader.read().then((r) => ({ kind: 'chunk', ...r })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), remaining)),
      ]);
      if (next.kind === 'timeout' || next.done) break;

      buffer += decoder.decode(next.value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim());
        if (dataLines.length > 0) {
          try {
            const parsed = JSON.parse(dataLines.join('\n'));
            if (parsed.id === targetId) return parsed;
            if (parsed.error && parsed.id === null) return parsed;
          } catch {
            // skip non-JSON events
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cancel
    }
  }
  return null;
}

function fail(msg, extra) {
  console.error(`smoke-mcp-client: FAIL — ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

async function main() {
  // ── 1. initialize ──
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hive-smoke-client', version: '0.1.0' },
    },
  });
  if (init.status !== 200) fail(`initialize returned status ${init.status}`, init);
  if (!init.body || init.body.error) fail('initialize returned error', init.body);
  if (!init.sessionId) fail('initialize did not return mcp-session-id header');
  const sessionId = init.sessionId;
  console.log(`smoke-mcp-client: initialize ok (sessionId=${sessionId})`);

  // ── 2. notifications/initialized ──
  const inited = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  if (inited.status !== 202 && inited.status !== 200 && inited.status !== 204) {
    fail(`notifications/initialized returned status ${inited.status}`);
  }

  // ── 3. tools/call get_agent_config ──
  const toolCall = await rpc(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_agent_config', arguments: {} },
    },
    sessionId,
  );
  if (toolCall.status !== 200) fail(`tools/call returned status ${toolCall.status}`, toolCall);
  if (!toolCall.body || toolCall.body.error) fail('tools/call returned error', toolCall.body);

  const result = toolCall.body.result;
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    fail('tools/call result missing content array', toolCall.body);
  }
  const textContent = result.content.find((c) => c.type === 'text');
  if (!textContent) fail('tools/call result has no text content', result.content);
  let parsedConfig;
  try {
    parsedConfig = JSON.parse(textContent.text);
  } catch (err) {
    fail(`tools/call text content is not JSON: ${err.message}`, textContent);
  }

  // get_agent_config returns the field as `participant_id` (snake_case wire
  // shape per [[API MCP — Tools]] tech spec).
  const actualParticipantId = parsedConfig.participant_id ?? parsedConfig.participantId;
  if (actualParticipantId !== expectedParticipantId) {
    fail(
      `participant_id mismatch — expected ${expectedParticipantId}, got ${actualParticipantId}`,
      parsedConfig,
    );
  }

  console.log(`smoke-mcp-client: get_agent_config ok (participant_id=${actualParticipantId})`);
  console.log('smoke-mcp-client: PASS');
}

main().catch((err) => {
  console.error(`smoke-mcp-client: unhandled error — ${err.stack ?? err.message}`);
  process.exit(1);
});
