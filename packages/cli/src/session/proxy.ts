// `hivectl mcp proxy`: the stdio MCP server Claude Code launches once per
// session (ADR-026 decision 3). One process is one session. Towards Claude Code
// it negotiates whatever revision the client offers; towards Hive it speaks
// Streamable HTTP 2026-07-28 with the session's Worker token, holds the single
// listen stream, renews the token at half its life, and registers again with the
// enrollment credential when the token is rejected.
//
// Before registration it exposes only two local tools (register_session,
// session_status) and answers tools/list without cache; after registration it
// emits notifications/tools/list_changed and passes Hive's catalog through as is
// (without the server's own register_session).
//
// It never exits because of Hive or the network: failures degrade into the
// last error of session_status. It ends on stdin EOF or a signal (see the command).

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { DEFAULT_BACKOFF, abortableSleep, backoffDelay } from '@hive/client';
import type { BackoffOptions, LogEntry, WatchEvent } from '@hive/client';
import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext, Tool, Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Client } from '@modelcontextprotocol/client';
import { HIVE_VERSION } from '@hive/shared';

import { createDiagnostics, parseLogLevel } from './diagnostics.js';
import type { Diagnostics } from './diagnostics.js';
import {
  processStartTime,
  publishProxyEntry,
  readPidMapEntry,
  removeProxyEntry,
} from './pid-map.js';
import type { StartTimeOf } from './pid-map.js';
import { isRetryableFailure, SessionRegistration } from './registration.js';
import type { RegisterRequest, RegistrationOutcome } from './registration.js';
import { configRoot, projectKey, readPrivateJson, statePaths } from './state-dir.js';
import type { StatePaths } from './state-dir.js';
import { createSessionStream } from './stream.js';
import { openTokenSlot } from './token-store.js';
import { Upstream, toSessionFailure } from './upstream.js';
import type { FetchLike, SessionErrorCode, SessionFailure } from './upstream.js';

export interface ProxyTimings {
  probeTimeoutMs: number;
  silenceTimeoutMs: number;
  /** How long a rejected session keeps trying to register again before giving up. */
  authRetryMaxMs: number;
  /** Lower bound of the delay before a renewal. */
  renewFloorMs: number;
  backoff: BackoffOptions;
}

const DEFAULT_TIMINGS: ProxyTimings = {
  probeTimeoutMs: 20_000,
  silenceTimeoutMs: 45_000,
  authRetryMaxMs: 300_000,
  renewFloorMs: 1_000,
  backoff: DEFAULT_BACKOFF,
};

export interface ProxyConfig {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  /** PID of the `claude` process: the parent of the proxy. */
  claudePid: number;
  stderr(text: string): void;
  /** Downstream transport (stdio of the process in production). Its close ends the proxy. */
  transport: Transport;
  startTimeOf?: StartTimeOf;
  timings?: Partial<ProxyTimings>;
  fetch?: FetchLike;
}

export type SessionStatus = {
  registered: boolean;
  name: string | null;
  agent_ref: string | null;
  hive: string | null;
  project: string;
  mode: 'interactive';
  last_error: { code: SessionErrorCode; message: string; at: string } | null;
};

export interface RunningProxy {
  /** Resolves once the proxy has shut down. */
  readonly closed: Promise<void>;
  shutdown(reason: string): Promise<void>;
  status(): SessionStatus;
  /** Listener of the stream events (the local waker channel attaches here). */
  onStreamEvent(listener: (event: WatchEvent) => void): void;
}

interface EnrollmentRecord {
  serverUrl: string;
  credential: string;
}

const LOCAL_TOOL_NAMES = new Set(['register_session', 'session_status']);

const INSTRUCTIONS =
  'Hive agent messaging through a local session proxy. Call session_status to learn whether ' +
  'this session is registered in Hive. If it is not, agree a name and a one-line description ' +
  'with the user and call register_session; the rest of the Hive tools appear after that.';

const REGISTER_TOOL: Tool = {
  name: 'register_session',
  title: 'Register this session in Hive',
  description:
    'Registers this Claude Code session in Hive as a named Worker agent so other agents can ' +
    'find and message it. Calling it again with the same name updates the description; with ' +
    'another name the session leaves the previous one.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, description: 'Agent name, for example sre-k8s.' },
      description: {
        type: 'string',
        minLength: 1,
        maxLength: 280,
        description: 'One line saying what this session works on.',
      },
      capabilities: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'description'],
  },
};

const STATUS_TOOL: Tool = {
  name: 'session_status',
  title: 'Hive session status',
  description:
    'Local and read-only: whether this session is registered in Hive, its name and agent ' +
    'reference, the Hive, the project, the mode and the last error. Never contacts Hive.',
  inputSchema: { type: 'object', properties: {} },
};

function parseEnrollment(raw: unknown): EnrollmentRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const serverUrl = r['serverUrl'];
  const credential = r['credential'];
  if (typeof serverUrl !== 'string' || serverUrl === '') return undefined;
  if (typeof credential !== 'string' || credential === '') return undefined;
  return { serverUrl, credential };
}

function toolResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError && { isError: true }),
  };
}

function parseRegisterArguments(raw: unknown): RegisterRequest | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const { name, description, capabilities } = r;
  if (typeof name !== 'string' || name === '') return undefined;
  if (typeof description !== 'string' || description === '') return undefined;
  if (
    capabilities !== undefined &&
    !(Array.isArray(capabilities) && capabilities.every((c) => typeof c === 'string'))
  ) {
    return undefined;
  }
  return { name, description, ...(capabilities !== undefined && { capabilities }) };
}

/** Wraps the downstream transport to learn when Claude Code goes away (stdin EOF). */
class ObservedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;

  constructor(
    private readonly inner: Transport,
    onEnd: () => void,
  ) {
    inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    inner.onerror = (error) => this.onerror?.(error);
    inner.onclose = () => {
      this.onclose?.();
      onEnd();
    };
    if (inner.setProtocolVersion) {
      this.setProtocolVersion = (v) => inner.setProtocolVersion?.(v);
    }
    if (inner.setSupportedProtocolVersions) {
      this.setSupportedProtocolVersions = (v) => inner.setSupportedProtocolVersions?.(v);
    }
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(...args: Parameters<Transport['send']>): Promise<void> {
    return this.inner.send(...args);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function streamLogLevel(event: string): 'debug' | 'info' | 'warn' {
  if (event === 'watch.connected') return 'info';
  if (event === 'watch.connect_failed' || event === 'watch.disconnected') return 'warn';
  return 'debug';
}

export function startProxy(config: ProxyConfig): RunningProxy {
  const timings: ProxyTimings = { ...DEFAULT_TIMINGS, ...config.timings };
  const diag: Diagnostics = createDiagnostics(
    (line) => config.stderr(line),
    parseLogLevel(config.env['HIVE_PROXY_LOG_LEVEL']),
  );
  const startTimeOf = config.startTimeOf ?? processStartTime;
  const paths: StatePaths = statePaths(configRoot(config.env, config.home));
  const projectDir = config.env['CLAUDE_PROJECT_DIR'] || config.cwd;
  const shutdownSignal = new AbortController();
  let lastError: SessionStatus['last_error'] = null;

  const setError = (failure: SessionFailure): void => {
    lastError = { code: failure.code, message: failure.message, at: new Date().toISOString() };
    diag.log('warn', 'proxy.error', { code: failure.code, message: failure.message });
  };

  let key: string | undefined;
  try {
    key = projectKey(projectDir);
  } catch {
    key = undefined;
  }

  const readEnrollment = (): EnrollmentRecord | undefined => {
    if (key === undefined) return undefined;
    try {
      const record = parseEnrollment(readPrivateJson(paths.enrollment(key)));
      if (record !== undefined) diag.secret(record.credential);
      return record;
    } catch (err) {
      setError({ ...toStateFailure(err) });
      return undefined;
    }
  };

  const enrollment = readEnrollment();
  if (enrollment === undefined && lastError === null) {
    setError({
      code: 'not_installed',
      message: `no Hive enrollment for ${projectDir}; run \`hivectl claude install\` in this folder`,
    });
  }

  const upstream = enrollment
    ? new Upstream({
        url: enrollment.serverUrl,
        clientVersion: HIVE_VERSION,
        probeTimeoutMs: timings.probeTimeoutMs,
        ...(config.fetch && { fetch: config.fetch }),
      })
    : undefined;

  // ── upstream discovery (single flight) ──
  let discovering: Promise<SessionFailure | undefined> | undefined;
  const ensureDiscovered = (bearer: string): Promise<SessionFailure | undefined> => {
    if (upstream === undefined) {
      return Promise.resolve({ code: 'not_installed', message: 'no Hive enrollment' });
    }
    if (upstream.isDiscovered) return Promise.resolve(undefined);
    discovering ??= upstream
      .discover(bearer)
      .then((outcome) => {
        if (outcome.ok) return undefined;
        setError(outcome);
        return { code: outcome.code, message: outcome.message };
      })
      .finally(() => {
        discovering = undefined;
      });
    return discovering;
  };

  // ── stream, renewal, registration ──
  const streamListeners: ((event: WatchEvent) => void)[] = [];
  let catalogStale = false;
  const servers = new Set<McpServer>();
  const notifyListChanged = (): void => {
    for (const server of servers) {
      server.server.sendToolListChanged().catch(() => undefined);
    }
  };

  let renewTimer: NodeJS.Timeout | undefined;
  let renewFailures = 0;
  const clearRenewal = (): void => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = undefined;
  };

  const registration: SessionRegistration = new SessionRegistration({
    serverUrl: enrollment?.serverUrl ?? '',
    now: () => Date.now(),
    enrollmentCredential: () => readEnrollment()?.credential,
    callRegister: async (bearer, args) => {
      const missing = await ensureDiscovered(readEnrollment()?.credential ?? bearer);
      if (missing !== undefined) return { ok: false, ...missing };
      if (upstream === undefined)
        return { ok: false, code: 'not_installed', message: 'no Hive enrollment' };
      return upstream.registerSession(bearer, args);
    },
    openSlot: (name) => (key === undefined ? undefined : openTokenSlot(paths, key, name)),
    leave: async () => {
      clearRenewal();
      await stream.stop();
    },
  });

  const stream = createSessionStream({
    url: enrollment?.serverUrl ?? 'http://invalid',
    clientVersion: HIVE_VERSION,
    probeTimeoutMs: timings.probeTimeoutMs,
    silenceTimeoutMs: timings.silenceTimeoutMs,
    backoff: timings.backoff,
    token: () => registration.current?.token,
    onEvent: (event) => {
      for (const listener of streamListeners) listener(event);
    },
    onConnected: () => {
      if (catalogStale) {
        catalogStale = false;
        notifyListChanged();
      }
    },
    onAuthRejected: () => {
      void recoverAuth();
    },
    onFatal: (message) => setError({ code: 'protocol_unsupported', message }),
    log: (entry: LogEntry) => {
      const { event, ...rest } = entry;
      diag.log(streamLogLevel(event), event, rest);
    },
  });

  const claudeStartTime = startTimeOf(config.claudePid);
  const proxyHandle = randomBytes(16).toString('hex');
  const publishProxy = (): void => {
    if (claudeStartTime === undefined) return;
    const current = registration.current;
    try {
      publishProxyEntry(paths, {
        claudePid: config.claudePid,
        claudeStartTime,
        proxyHandle,
        socketPath: join(paths.root, 'run', `${proxyHandle}.sock`),
        registered: current !== undefined,
        ...(current && { name: current.name }),
      });
    } catch (err) {
      diag.log('warn', 'proxy.publish_failed', { message: (err as Error).message });
    }
  };

  const scheduleRenewal = (delayMs?: number): void => {
    clearRenewal();
    const current = registration.current;
    if (current === undefined || shutdownSignal.signal.aborted) return;
    const half = (current.expiresAt.getTime() - Date.now()) / 2;
    renewTimer = setTimeout(() => void renewNow(), delayMs ?? Math.max(timings.renewFloorMs, half));
    renewTimer.unref();
  };

  const afterRegistered = (
    outcome: Extract<RegistrationOutcome, { ok: true }>,
    announce: boolean,
  ): void => {
    diag.secret(outcome.registered.token);
    lastError = null;
    renewFailures = 0;
    publishProxy();
    if (!stream.running) stream.start();
    scheduleRenewal();
    diag.log('info', 'proxy.registered', { name: outcome.registered.name, via: outcome.via });
    if (announce) notifyListChanged();
  };

  const becomeUnregistered = async (): Promise<void> => {
    registration.drop();
    clearRenewal();
    await stream.stop();
    publishProxy();
    notifyListChanged();
  };

  let recovering: Promise<boolean> | undefined;
  const recoverAuth = (): Promise<boolean> => {
    recovering ??= (async () => {
      if (registration.current !== undefined) {
        const renewed = await registration.renew();
        if (renewed.ok) {
          afterRegistered(renewed, false);
          return true;
        }
        if (renewed.code !== 'auth_rejected') {
          setError(renewed);
          scheduleRenewal(backoffDelay(renewFailures++, timings.backoff, Math.random));
          return false;
        }
      }
      const deadline = Date.now() + timings.authRetryMaxMs;
      let attempt = 0;
      while (!shutdownSignal.signal.aborted) {
        const outcome = await registration.reenroll();
        if (outcome.ok) {
          afterRegistered(outcome, true);
          return true;
        }
        setError(outcome);
        if (outcome.code === 'not_registered') return false;
        if (!isRetryableFailure(outcome.code) || Date.now() >= deadline) break;
        const delay = Math.min(
          backoffDelay(attempt++, timings.backoff, Math.random),
          deadline - Date.now(),
        );
        await abortableSleep(delay, shutdownSignal.signal);
      }
      await becomeUnregistered();
      return false;
    })().finally(() => {
      recovering = undefined;
    });
    return recovering;
  };

  const renewNow = async (): Promise<void> => {
    const renewed = await registration.renew();
    if (renewed.ok) {
      afterRegistered(renewed, false);
      return;
    }
    if (renewed.code === 'not_registered') return;
    if (renewed.code === 'auth_rejected') {
      await recoverAuth();
      return;
    }
    setError(renewed);
    scheduleRenewal(backoffDelay(renewFailures++, timings.backoff, Math.random));
  };

  const register = async (request: RegisterRequest): Promise<RegistrationOutcome> => {
    const outcome = await registration.register(request);
    if (outcome.ok) afterRegistered(outcome, true);
    else {
      setError(outcome);
      if (registration.current === undefined) publishProxy();
    }
    return outcome;
  };

  // ── auto-registration from the PID map ──
  const attempted = new Set<string>();
  const autoRegister = async (): Promise<void> => {
    if (registration.current !== undefined || upstream === undefined) return;
    let entry;
    try {
      entry = readPidMapEntry(paths, config.claudePid, startTimeOf);
    } catch (err) {
      setError(toStateFailure(err));
      return;
    }
    if (entry?.name === undefined) return;
    const attemptKey = `${entry.sessionId}\u0000${entry.name}`;
    if (attempted.has(attemptKey)) return;
    attempted.add(attemptKey);
    diag.log('info', 'proxy.auto_register', { name: entry.name, source: entry.source });
    await register({
      name: entry.name,
      ...(entry.description !== undefined && { description: entry.description }),
    });
  };

  // ── downstream (Claude Code) ──
  let workerClient: Client | undefined;
  let workerClientFor: string | undefined;
  const worker = async (): Promise<Client> => {
    const current = registration.current;
    if (current === undefined || upstream === undefined) {
      throw new ProtocolError(-32001, 'the session is not registered in Hive');
    }
    if (workerClient === undefined || workerClientFor !== current.agentId) {
      await workerClient?.close().catch(() => undefined);
      workerClient = await upstream.connect(() => registration.current?.token ?? '');
      workerClientFor = current.agentId;
    }
    return workerClient;
  };

  /** Runs a request against Hive; on -32001 renews (or registers again) and retries once. */
  const withWorker = async <T>(step: (client: Client) => Promise<T>): Promise<T> => {
    try {
      return await step(await worker());
    } catch (err) {
      if (toSessionFailure(err).code !== 'auth_rejected' || registration.current === undefined) {
        throw err;
      }
      if (!(await recoverAuth())) throw err;
      return step(await worker());
    }
  };

  let lastCatalog: Tool[] | undefined;
  const listTools = async (): Promise<{ tools: Tool[] }> => {
    const local = [REGISTER_TOOL, STATUS_TOOL];
    if (registration.current === undefined) {
      await autoRegister();
    }
    if (registration.current === undefined) return { tools: local };
    try {
      const listed = await withWorker((client) =>
        client.listTools(undefined, { cacheMode: 'bypass' }),
      );
      lastCatalog = listed.tools.filter((t) => !LOCAL_TOOL_NAMES.has(t.name));
    } catch (err) {
      const failure = toSessionFailure(err);
      setError(failure);
      if (lastCatalog === undefined) {
        catalogStale = true;
        return { tools: local };
      }
    }
    return { tools: [...(lastCatalog ?? []), ...local] };
  };

  const status = (): SessionStatus => {
    const current = registration.current;
    return {
      registered: current !== undefined,
      name: current?.name ?? null,
      agent_ref: current?.agentRef ?? null,
      hive: enrollment?.serverUrl ?? null,
      project: projectDir,
      mode: 'interactive',
      last_error: lastError,
    };
  };

  const callTool = async (
    params: { name: string; arguments?: Record<string, unknown> | undefined },
    ctx: ServerContext,
  ): Promise<CallToolResult> => {
    if (params.name === 'session_status') return toolResult(status());
    if (params.name === 'register_session') {
      const request = parseRegisterArguments(params.arguments);
      if (request === undefined) {
        throw new ProtocolError(
          -32602,
          'register_session needs a name and a one-line description (at most 280 characters)',
        );
      }
      const outcome = await register(request);
      if (!outcome.ok) {
        return toolResult({ error: { code: outcome.code, message: outcome.message } }, true);
      }
      return toolResult({
        registered: true,
        name: outcome.registered.name,
        agent_ref: outcome.registered.agentRef,
        agent_id: outcome.registered.agentId,
        expires_at: outcome.registered.expiresAt.toISOString(),
      });
    }
    if (registration.current === undefined) {
      return toolResult(
        {
          error: {
            code: 'not_registered',
            message: 'this session is not registered in Hive; call register_session first',
          },
        },
        true,
      );
    }
    const progressToken = ctx.mcpReq._meta?.progressToken;
    return withWorker((client) =>
      client.callTool(
        {
          name: params.name,
          ...(params.arguments !== undefined && { arguments: params.arguments }),
        },
        {
          signal: ctx.mcpReq.signal,
          ...(progressToken !== undefined && {
            onprogress: (progress) => {
              ctx.mcpReq
                .notify({
                  method: 'notifications/progress',
                  params: { ...progress, progressToken },
                })
                .catch(() => undefined);
            },
          }),
        },
      ),
    );
  };

  const buildServer = (): McpServer => {
    const mcp = new McpServer(
      { name: 'hivectl-mcp-proxy', version: HIVE_VERSION },
      {
        instructions: INSTRUCTIONS,
        cacheHints: {
          'tools/list': { ttlMs: 0, cacheScope: 'private' },
          'resources/list': { ttlMs: 0, cacheScope: 'private' },
          'resources/read': { ttlMs: 0, cacheScope: 'private' },
        },
      },
    );
    const low = mcp.server;
    low.registerCapabilities({ tools: { listChanged: true }, resources: {} });
    low.setRequestHandler('tools/list', () => listTools());
    low.setRequestHandler('tools/call', async (request, ctx) =>
      low.projectCallToolResult(await callTool(request.params, ctx), undefined),
    );
    low.setRequestHandler('resources/list', async (request, ctx) => {
      if (registration.current === undefined) return { resources: [] };
      return withWorker((client) =>
        client.listResources(request.params, { signal: ctx.mcpReq.signal, cacheMode: 'bypass' }),
      );
    });
    low.setRequestHandler('resources/read', async (request, ctx) =>
      withWorker((client) =>
        client.readResource(request.params, { signal: ctx.mcpReq.signal, cacheMode: 'bypass' }),
      ),
    );
    servers.add(mcp);
    return mcp;
  };

  // ── lifecycle ──
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      diag.log('info', 'proxy.shutdown', { reason });
      shutdownSignal.abort();
      clearRenewal();
      await stream.stop().catch(() => undefined);
      registration.drop();
      try {
        removeProxyEntry(paths, config.claudePid);
      } catch {
        // Best effort: an orphan entry is ignored by its start time anyway.
      }
      await workerClient?.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      for (const server of servers) await server.close().catch(() => undefined);
      resolveClosed();
    })();
    return shuttingDown;
  };

  const handle = serveStdio(() => buildServer(), {
    transport: new ObservedTransport(config.transport, () => void shutdown('client_closed')),
    onerror: (error) => diag.log('debug', 'proxy.downstream_error', { message: error.message }),
  });

  publishProxy();
  if (enrollment !== undefined) {
    void ensureDiscovered(enrollment.credential).then(() => autoRegister());
  }

  return {
    closed,
    shutdown,
    status,
    onStreamEvent: (listener) => {
      streamListeners.push(listener);
    },
  };
}

function toStateFailure(err: unknown): SessionFailure {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  return code === 'SESSION_STATE_INSECURE_PERMS'
    ? { code: 'session_state_insecure_perms', message }
    : { code: 'session_state_invalid', message };
}
