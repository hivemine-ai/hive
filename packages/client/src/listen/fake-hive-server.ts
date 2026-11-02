// A stand-in for the Hive MCP edge, built on the official 2.x server SDK. It
// exists so `hivectl watch` can be tested before the real server speaks
// `subscriptions/listen`. It copies no code from `packages/server`: it only
// reproduces the observable wire contract that `watch` depends on.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';

import { InMemoryServerEventBus, McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface FakeUnread {
  count: number;
  senders: string[];
}

export interface FakeHiveServerOptions {
  /** Bearer token to participant id. */
  tokens: Record<string, string>;
  keepAliveMs?: number;
  /** Emit a `replay` event right after each listen acknowledgment when unread > 0. */
  replayOnListen?: boolean;
}

export interface FakeHiveServer {
  url: string;
  /** Every `tools/call` name received, in order. */
  toolCalls: string[];
  /** Every JSON-RPC method received, in order. */
  methods: string[];
  /** Number of `subscriptions/listen` requests accepted. */
  listenCount(): number;
  setUnread(participant: string, unread: FakeUnread): void;
  /** Publishes a Waggle event on a participant's mailbox. */
  publish(
    participant: string,
    payload: { eventId: string; senders: string[]; count: number; kind?: 'online' | 'replay' },
  ): void;
  /** Participants with an open listen stream that subscribes their own mailbox. */
  online(): string[];
  /** Destroys every open stream socket (a network cut). */
  dropStreams(): void;
  /** Stops writing to open streams without closing them (a silent stall). */
  stallStreams(): void;
  /** Answers every request with HTTP 401 and JSON-RPC `-32001`. */
  setRejectAuth(reject: boolean): void;
  /** Answers every request with HTTP 400 and JSON-RPC `-32022`. */
  setUnsupportedProtocol(unsupported: boolean): void;
  /** Delays `tools/call` by this many ms. */
  setToolDelay(ms: number): void;
  /** Makes `tools/call` of `check_unread_messages` answer a JSON-RPC internal error. */
  setCheckFails(fails: boolean): void;
  close(): Promise<void>;
}

const mailboxUri = (participant: string): string => `hive://cells/cell-${participant}`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  data?: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code, message, ...(data ? { data } : {}) },
    }),
  );
}

export async function startFakeHiveServer(options: FakeHiveServerOptions): Promise<FakeHiveServer> {
  const bus = new InMemoryServerEventBus(() => {});
  const unread = new Map<string, FakeUnread>();
  const streams = new Map<symbol, { participant: string; mailbox: boolean; socket: Socket }>();
  const sockets = new Set<Socket>();
  const toolCalls: string[] = [];
  const methods: string[] = [];
  let listens = 0;
  let rejectAuth = false;
  let unsupported = false;
  let toolDelayMs = 0;
  let checkFails = false;
  let stalled = false;

  const publish: FakeHiveServer['publish'] = (participant, p) => {
    bus.publish({
      kind: 'resource_updated',
      uri: mailboxUri(participant),
      params: {
        _meta: {
          hiveWaggle: {
            kind: p.kind ?? 'online',
            recipient_id: participant,
            unread_count: p.count,
            sender_ids: p.senders,
            emitted_at: new Date().toISOString(),
            waggle_id: `w-${p.eventId}`,
            event_id: p.eventId,
          },
        },
      },
    });
  };

  const factory = ({ authInfo }: { authInfo?: { extra?: Record<string, unknown> } }): McpServer => {
    const participant = String(authInfo?.extra?.['participant']);
    const server = new McpServer(
      { name: 'fake-hive', version: '0.0.0' },
      { capabilities: { resources: { subscribe: true } } },
    );
    server.registerResource(
      'mailbox',
      mailboxUri(participant),
      { description: 'The caller mailbox.', mimeType: 'application/json' },
      (uri) => ({
        contents: [{ uri: uri.href, text: JSON.stringify(unread.get(participant) ?? {}) }],
      }),
    );
    server.registerTool(
      'check_unread_messages',
      { description: 'Unread count and sender ids.', inputSchema: z.object({}) },
      async () => {
        toolCalls.push('check_unread_messages');
        if (toolDelayMs > 0) await new Promise((r) => setTimeout(r, toolDelayMs));
        if (checkFails) throw new Error('check failed on purpose');
        const u = unread.get(participant) ?? { count: 0, senders: [] };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ unread_count: u.count, sender_ids: u.senders }),
            },
          ],
        };
      },
    );
    server.registerTool(
      'read_mailbox',
      { description: 'Reads message bodies.', inputSchema: z.object({}) },
      () => {
        toolCalls.push('read_mailbox');
        return { content: [{ type: 'text' as const, text: '[]' }] };
      },
    );
    return server;
  };

  const handler = createMcpHandler(factory, {
    legacy: 'reject',
    bus,
    ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
  });

  const http: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { method?: string; params?: Record<string, unknown> };
      const method = body.method ?? '';
      methods.push(method);
      if (method === 'tools/call') toolCalls.push(`call:${String(body.params?.['name'])}`);
      if (rejectAuth) return jsonRpcError(res, 401, -32001, 'authentication failed');
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const participant = token ? options.tokens[token] : undefined;
      if (!participant) return jsonRpcError(res, 401, -32001, 'authentication failed');
      if (unsupported) {
        return jsonRpcError(res, 400, -32022, 'unsupported protocol version', {
          supported: ['2026-07-28'],
        });
      }

      const isListen = method === 'subscriptions/listen';
      const notifications = (body.params?.['notifications'] ?? {}) as {
        resourceSubscriptions?: string[];
      };
      const subscribed = notifications.resourceSubscriptions ?? [];
      if (isListen && subscribed.some((u) => u !== mailboxUri(participant))) {
        return jsonRpcError(res, 200, -32602, 'invalid input');
      }

      const abort = new AbortController();
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === 'string') headers.set(k, v);
      const webReq = new Request(`http://${req.headers.host ?? 'localhost'}/mcp`, {
        method: 'POST',
        headers,
        body: raw,
        signal: abort.signal,
      });
      const response = await handler.fetch(webReq, {
        authInfo: { token: token ?? '', clientId: participant, scopes: [], extra: { participant } },
        parsedBody: body,
      });

      const isSse = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
      let streamKey: symbol | undefined;
      if (isListen && isSse) {
        listens += 1;
        streamKey = Symbol('stream');
        streams.set(streamKey, {
          participant,
          mailbox: subscribed.includes(mailboxUri(participant)),
          socket: req.socket,
        });
        res.on('close', () => {
          abort.abort();
          if (streamKey) streams.delete(streamKey);
        });
        if (options.replayOnListen) {
          const u = unread.get(participant);
          if (u && u.count > 0) {
            setTimeout(() => {
              publish(participant, {
                eventId: `replay-${listens}`,
                senders: u.senders,
                count: u.count,
                kind: 'replay',
              });
            }, 50);
          }
        }
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return void res.end();
      const readable = Readable.fromWeb(response.body);
      readable.on('error', () => res.destroy());
      if (isListen) {
        readable.on('data', (chunk: Buffer) => {
          if (!stalled) res.write(chunk);
        });
        readable.on('end', () => res.end());
      } else {
        readable.pipe(res);
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  http.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    toolCalls,
    methods,
    listenCount: () => listens,
    setUnread: (participant, u) => void unread.set(participant, u),
    publish,
    online: () => [
      ...new Set([...streams.values()].filter((s) => s.mailbox).map((s) => s.participant)),
    ],
    dropStreams: () => {
      for (const s of streams.values()) s.socket.destroy();
    },
    stallStreams: () => {
      stalled = true;
    },
    setRejectAuth: (v) => void (rejectAuth = v),
    setUnsupportedProtocol: (v) => void (unsupported = v),
    setToolDelay: (ms) => void (toolDelayMs = ms),
    setCheckFails: (v) => void (checkFails = v),
    close: async () => {
      await handler.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
