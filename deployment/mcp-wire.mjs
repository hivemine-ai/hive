// Raw HTTP helpers shared by the deployment smoke scripts. They speak MCP
// revision 2026-07-28 with no SDK, so the CI install footprint stays small and
// a regression in the server cannot be hidden by a forgiving client.

export const PROTOCOL_VERSION = '2026-07-28';

const REQUEST_TIMEOUT_MS = 10_000;

/** Per-request envelope that the 2026-07-28 revision requires in `params._meta`. */
export function envelope() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/**
 * POST one JSON-RPC request to the MCP endpoint. Every request carries its own
 * version, method and name headers; there is no session to carry between calls.
 * `headers` overrides the defaults, and a `null` value removes a header.
 */
export async function rpc({ url, jwt, id = 1, method, params, headers = {} }) {
  const merged = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': method,
    ...headers,
  };
  if (jwt) merged.authorization = `Bearer ${jwt}`;
  if (typeof params?.name === 'string') merged['mcp-name'] = params.name;
  for (const [name, value] of Object.entries(merged)) {
    if (value === null) delete merged[name];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: merged,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, headers: res.headers, body: parseBody(await res.text(), res) };
}

/** Plain request with any HTTP method, for the verbs the server must refuse. */
export async function plain({ url, jwt, method }) {
  const res = await fetch(url, {
    method,
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.text();
  return { status: res.status, headers: res.headers };
}

function parseBody(text, res) {
  if (text.length === 0) return null;
  const contentType = res.headers.get('content-type') ?? '';
  const json = contentType.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')
    : text;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
