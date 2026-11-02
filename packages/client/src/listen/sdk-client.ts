// Thin adapter over the official 2.x MCP client SDK. Everything that touches the
// SDK lives here, so the rest of the library depends on `ListenError` only.

import {
  Client,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { ListenError } from './errors.js';
import { livenessFetch } from './liveness-fetch.js';
import type { FetchLike } from './liveness-fetch.js';

export const PROTOCOL_REVISION = '2026-07-28';
const RPC_UNAUTHORIZED = -32001;
const RPC_UNSUPPORTED_PROTOCOL = -32022;

export interface SdkClientOptions {
  /** MCP endpoint of the Hive server. */
  url: string;
  /** Bearer credential. Never logged, never put in an error message. */
  credential: string;
  /** Probe timeout for the version-negotiation exchange. */
  probeTimeoutMs: number;
  clientName?: string;
  clientVersion?: string;
  fetch?: FetchLike;
  /** Called for every chunk of bytes read from a streaming response. */
  onBytes?: () => void;
}

/** Maps any SDK failure to a `ListenError` without leaking request details. */
export function toListenError(err: unknown): ListenError {
  if (err instanceof ListenError) return err;
  if (err instanceof SdkHttpError && (err.status === 401 || err.status === 403)) {
    return new ListenError('auth_rejected', 'the server rejected the credential', { cause: err });
  }
  if (err instanceof ProtocolError) {
    if (err.code === RPC_UNAUTHORIZED) {
      return new ListenError('auth_rejected', 'the server rejected the credential', { cause: err });
    }
    if (err.code === RPC_UNSUPPORTED_PROTOCOL) {
      return new ListenError(
        'protocol_unsupported',
        `the server does not serve MCP revision ${PROTOCOL_REVISION}`,
        { cause: err },
      );
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ListenError('transport', message, { cause: err });
}

/** Builds and connects a client pinned to the 2026-07-28 revision. */
export async function connectClient(options: SdkClientOptions): Promise<Client> {
  const base: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${options.credential}` } },
    fetch: options.onBytes ? livenessFetch(base, options.onBytes) : base,
  });
  const client = new Client(
    { name: options.clientName ?? 'hivectl-watch', version: options.clientVersion ?? '0.0.0' },
    {
      versionNegotiation: {
        mode: { pin: PROTOCOL_REVISION },
        probe: { timeoutMs: options.probeTimeoutMs },
      },
    },
  );
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close().catch(() => {});
    throw toListenError(err);
  }
  return client;
}

export async function closeClient(client: Client, timeoutMs = 1000): Promise<void> {
  await Promise.race([
    client.close().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}
