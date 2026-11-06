// The proxy's side towards Hive: Streamable HTTP, revision 2026-07-28 only, with
// the bearer chosen per call (enrollment credential, last Worker token, current
// Worker token). Every SDK failure is mapped to a session error code here, so the
// rest of the proxy never touches SDK error classes.

import {
  Client,
  ProtocolError,
  SdkError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

export const UPSTREAM_REVISION = '2026-07-28';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type DiscoverResult = Awaited<ReturnType<Client['discover']>>;

export type SessionErrorCode =
  | 'auth_rejected'
  | 'enrollment_rejected'
  | 'forbidden'
  | 'name_in_use'
  | 'name_taken'
  | 'agent_suspended'
  | 'enrollment_quota_exceeded'
  | 'rate_limited'
  | 'invalid_input'
  | 'protocol_unsupported'
  | 'server_mismatch'
  | 'not_installed'
  | 'description_unknown'
  | 'session_state_insecure_perms'
  | 'session_state_invalid'
  | 'not_registered'
  | 'upstream_error'
  | 'transport';

export interface SessionFailure {
  code: SessionErrorCode;
  message: string;
  /** JSON-RPC code of the server's answer, when there was one. */
  rpcCode?: number;
}

const RPC_CODES: Record<number, SessionErrorCode> = {
  [-32001]: 'auth_rejected',
  [-32006]: 'forbidden',
  [-32007]: 'name_in_use',
  [-32008]: 'name_taken',
  [-32009]: 'agent_suspended',
  [-32010]: 'enrollment_quota_exceeded',
  [-32011]: 'rate_limited',
  [-32022]: 'protocol_unsupported',
  [-32602]: 'invalid_input',
};

/** SDK negotiation failures that mean "no 2026-07-28 here", as opposed to an unreachable server. */
const UNSUPPORTED_REVISION =
  /did not offer pinned protocol version|no modern evidence|requires a 2026-07-28/;

/** Maps any upstream failure to a session failure, without request details. */
export function toSessionFailure(err: unknown): SessionFailure {
  if (err instanceof ProtocolError) {
    return {
      code: RPC_CODES[err.code] ?? 'upstream_error',
      message: err.message,
      rpcCode: err.code,
    };
  }
  if (err instanceof SdkHttpError) {
    if (err.status === 401)
      return { code: 'auth_rejected', message: 'the server rejected the bearer' };
    if (err.status === 403) return { code: 'forbidden', message: 'the server refused the request' };
    if (err.status === 429) return { code: 'rate_limited', message: 'too many registrations' };
  }
  if (err instanceof SdkError && UNSUPPORTED_REVISION.test(err.message)) {
    return {
      code: 'protocol_unsupported',
      message: `the Hive server does not serve MCP ${UPSTREAM_REVISION}`,
    };
  }
  return { code: 'transport', message: err instanceof Error ? err.message : String(err) };
}

export interface RegisterArgs {
  name: string;
  description: string;
  capabilities?: string[];
}

export type RegisterResponse =
  | { ok: true; agentRef: string; agentId: string; token: string; expiresAt: string }
  | ({ ok: false } & SessionFailure);

export type DiscoverOutcome = { ok: true } | ({ ok: false } & SessionFailure);

export interface UpstreamOptions {
  url: string;
  clientVersion: string;
  probeTimeoutMs: number;
  fetch?: FetchLike;
}

function parseRegistered(raw: unknown): RegisterResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fields = ['agent_ref', 'agent_id', 'token', 'expires_at'] as const;
  if (!fields.every((f) => typeof r[f] === 'string' && r[f] !== '')) {
    return {
      ok: false,
      code: 'upstream_error',
      message: 'register_session returned an invalid result',
    };
  }
  return {
    ok: true,
    agentRef: r['agent_ref'] as string,
    agentId: r['agent_id'] as string,
    token: r['token'] as string,
    expiresAt: r['expires_at'] as string,
  };
}

export class Upstream {
  private discovered: DiscoverResult | undefined;

  constructor(private readonly options: UpstreamOptions) {}

  get url(): string {
    return this.options.url;
  }

  private newClient(): Client {
    return new Client(
      { name: 'hivectl-mcp-proxy', version: this.options.clientVersion },
      {
        versionNegotiation: {
          mode: { pin: UPSTREAM_REVISION },
          probe: { timeoutMs: this.options.probeTimeoutMs },
        },
      },
    );
  }

  private transport(bearer: () => string): StreamableHTTPClientTransport {
    const base: FetchLike = this.options.fetch ?? ((input, init) => fetch(input, init));
    return new StreamableHTTPClientTransport(new URL(this.options.url), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${bearer()}`);
        return base(input, { ...init, headers });
      },
    });
  }

  /**
   * `server/discover` with the given bearer: the server must serve 2026-07-28 and
   * expose `tools` and `resources.subscribe`. The result is kept, so later
   * connections skip the probe (an expired token cannot pass one).
   */
  async discover(bearer: string): Promise<DiscoverOutcome> {
    const client = this.newClient();
    try {
      await client.connect(this.transport(() => bearer));
      const result = await client.discover();
      const caps = client.getServerCapabilities();
      if (caps?.tools === undefined || caps.resources?.subscribe !== true) {
        return {
          ok: false,
          code: 'server_mismatch',
          message: 'the Hive server does not expose tools and resource subscriptions',
        };
      }
      this.discovered = result;
      return { ok: true };
    } catch (err) {
      const failure = toSessionFailure(err);
      return { ok: false, ...failure };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  get isDiscovered(): boolean {
    return this.discovered !== undefined;
  }

  /** A client whose every request carries `bearer()`. */
  async connect(bearer: () => string): Promise<Client> {
    const client = this.newClient();
    const transport = this.transport(bearer);
    if (this.discovered !== undefined) {
      await client.connect(transport, { prior: { kind: 'modern', discover: this.discovered } });
    } else {
      await client.connect(transport);
    }
    return client;
  }

  /** Calls Hive's `register_session` with an enrollment credential or the last Worker token. */
  async registerSession(bearer: string, args: RegisterArgs): Promise<RegisterResponse> {
    let client: Client | undefined;
    try {
      client = await this.connect(() => bearer);
      const result = await client.callTool({
        name: 'register_session',
        arguments: {
          name: args.name,
          description: args.description,
          ...(args.capabilities !== undefined && { capabilities: args.capabilities }),
        },
      });
      if (result.isError === true) {
        return { ok: false, code: 'upstream_error', message: 'register_session reported an error' };
      }
      return parseRegistered(result.structuredContent);
    } catch (err) {
      return { ok: false, ...toSessionFailure(err) };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}
