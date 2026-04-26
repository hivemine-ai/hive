// End-to-end smoke test for PRY-006 (MCP Server + Tool Surface Slice 0).
//
// Exercises the 8 demoable steps from the tech spec § "Plan de implementación
// — Slice 0 — Pasos demoables" with REAL components:
//   - Real SQLite on disk (per ADR-008 + PRY-002/003/005 lessons; the tech
//     spec mentions Postgres but the repo's smoke suite uses SQLite real
//     uniformly).
//   - Real Issuer + Verifier (Ed25519 JWTs and IdentityContexts).
//   - Real Sender + Reader (Cell Store).
//   - Real VisibilityEngine (production factory; not stubbed — this slice
//     proves the cross-component wiring end-to-end).
//   - Real Notifications (Waggle Pipeline + Presence Registry).
//   - Real MCP transport (server.ts + http-host.ts) with the SDK 1.29.0.
//   - Two HTTP clients (worker-a, worker-b) using `fetch` global, sharing the
//     same fastify host.
//
// The push-notification path (worker-b receives Waggle within quiet window)
// is NOT covered by this smoke test because it requires an SSE stream open
// on the client side — see Slice 1+ for transport-level notification delivery
// validation. This smoke test instead asserts the polling path
// (`check_unread_messages`, `read_mailbox`) which is demoable end-to-end.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import {
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  generateKeypair,
  type CallerContext,
  type ParticipantsWriteRepo,
  type SigningKey,
  type UUIDv7,
} from '#domain/auth/index.js';
import { createCellsRepo } from '#domain/cells/index.js';
import { createCellsHookAdapter } from '#composition/cells-hook-adapter.js';
import { buildWire } from '#composition/wire.js';
import type { Wire } from '#composition/wire.js';
import { createDb, type DbConfig } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { createLogger } from '#observability/logger.js';

const SYSTEM_CALLER: CallerContext = {
  kind: 'system',
  osUser: 'pry-006-smoke',
  operatorNote: 'pry-006 hito-18 e2e smoke',
};

interface SmokeWorld {
  cleanup: () => Promise<void>;
  wire: Wire;
  baseUrl: string;
  jwtA: string;
  jwtB: string;
  workerAId: UUIDv7;
  workerBId: UUIDv7;
}

async function seedSmokeWorld(): Promise<SmokeWorld> {
  // ── filesystem & db (real SQLite on disk) ──
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry006-smoke-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
  const keysDir = path.join(workDir, 'keys');
  await fs.mkdir(keysDir, { recursive: true });

  const dbConfig: DbConfig = {
    dialect: 'sqlite',
    url: `sqlite:${dbPath}`,
    sqliteWal: false,
  };
  const db = createDb(dbConfig);
  await migrateToLatest(db);

  // ── signing key (real Ed25519) ──
  const signingKey: SigningKey = generateKeypair();
  await db
    .insertInto('signing_keys')
    .values({
      kid: signingKey.kid,
      algorithm: 'EdDSA',
      public_jwk: jsonStringify(signingKey.publicKey.export({ format: 'jwk' })),
      created_at: dateToIso(new Date()),
      retired_at: null,
      removed_at: null,
    })
    .execute();
  // Also persist the keypair to disk for `loadAllKeypairs` in the wire.
  const privatePem = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = signingKey.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.private.pem`), privatePem, {
    mode: 0o600,
  });
  await fs.writeFile(path.join(keysDir, `${signingKey.kid}.public.pem`), publicPem);

  // ── hive + colony ──
  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const now = new Date();
  await db
    .insertInto('hives')
    .values({ id: hiveId, name: 'smoke', created_at: dateToIso(now) })
    .execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default', created_at: dateToIso(now) })
    .execute();

  // ── repos with real cells hook (atomicity admin → cell) ──
  const cellsRepo = createCellsRepo(db);
  const cellsHook = createCellsHookAdapter(cellsRepo);
  const writeRepo: ParticipantsWriteRepo = createParticipantsWriteRepo(db, { cellsHook });
  const readRepo = createParticipantsReadRepo(db);

  // ── admin Hivekeeper ──
  const admin = await writeRepo.createHivekeeper(
    {
      hiveId,
      colonyId,
      email: 'admin@smoke.example',
      displayName: 'Smoke Admin',
      isAdmin: true,
    },
    SYSTEM_CALLER,
  );

  // ── workers A and B ──
  const workerA = await writeRepo.createAgent(
    {
      hiveId,
      colonyId,
      ownerId: admin.id,
      name: 'worker-a',
      type: 'worker',
      capabilities: ['cell.send', 'cell.read'],
    },
    SYSTEM_CALLER,
  );
  const workerB = await writeRepo.createAgent(
    {
      hiveId,
      colonyId,
      ownerId: admin.id,
      name: 'worker-b',
      type: 'worker',
      capabilities: ['cell.send', 'cell.read'],
    },
    SYSTEM_CALLER,
  );

  // ── credentials (real JWTs) ──
  const issuer = createIssuer({
    signingKey,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
    defaultTtlMs: 300_000,
    db,
  });
  const credA = await issuer.issueCredential({ participantId: workerA.id });
  const credB = await issuer.issueCredential({ participantId: workerB.id });

  // Close the bootstrap-only db handle — the wire opens its own via the same path.
  await db.destroy();

  // ── wire (production composition root) ──
  // Set env so the wire reads from the same DB + keys dir.
  process.env['HIVE_DB_DIALECT'] = 'sqlite';
  process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;

  const logger = createLogger({ level: 'silent' });
  const wire = await buildWire(
    { logger },
    {
      keysDir,
      httpHost: '127.0.0.1',
      httpPort: 0, // ephemeral
      readyzDbTimeoutMs: 1000,
      shutdownDrainTimeoutSeconds: 5,
    },
  );
  await wire.start();

  const port = wire.port();
  if (port === null) throw new Error('wire failed to bind a port');
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    wire,
    baseUrl,
    jwtA: credA.jwt,
    jwtB: credB.jwt,
    workerAId: workerA.id,
    workerBId: workerB.id,
    cleanup: async () => {
      await wire.stop();
      await fs.rm(workDir, { recursive: true, force: true });
      delete process.env['HIVE_DB_DIALECT'];
      delete process.env['HIVE_DB_URL'];
    },
  };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RpcOutcome {
  status: number;
  body: JsonRpcResponse | null;
  sessionId: string | null;
  rawText: string;
}

async function rpc(
  baseUrl: string,
  jwt: string,
  body: JsonRpcRequest,
  sessionId?: string,
): Promise<RpcOutcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${jwt}`,
  };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const returnedSession = res.headers.get('mcp-session-id');
  const contentType = res.headers.get('content-type') ?? '';

  if (res.status === 202 || res.status === 204) {
    // Notifications (no response expected) — drain and return.
    await drainBody(res);
    return { status: res.status, body: null, sessionId: returnedSession, rawText: '' };
  }

  if (contentType.includes('text/event-stream') && res.body) {
    // SSE: read until we get a `data:` line whose JSON body matches the request id.
    const targetId = body.id;
    const { parsed, raw } = await readSseUntilIdRaw(res.body, targetId);
    return {
      status: res.status,
      body: parsed,
      sessionId: returnedSession,
      rawText: parsed ? JSON.stringify(parsed) : raw,
    };
  }

  const text = await res.text();
  let parsed: JsonRpcResponse | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed, sessionId: returnedSession, rawText: text };
}

async function sendNotification(
  baseUrl: string,
  jwt: string,
  method: string,
  sessionId: string,
): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${jwt}`,
    'mcp-session-id': sessionId,
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method }),
  });
  await drainBody(res);
}

async function drainBody(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function readSseUntilIdRaw(
  stream: ReadableStream<Uint8Array>,
  targetId: number | string,
  timeoutMs = 2000,
): Promise<{ parsed: JsonRpcResponse | null; raw: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let allRaw = '';
  let result: JsonRpcResponse | null = null;

  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(50, deadline - Date.now());
      const next = await Promise.race([
        reader.read().then((r) => ({ kind: 'chunk' as const, ...r })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), remaining),
        ),
      ]);

      if (next.kind === 'timeout') break;
      if (next.done) break;

      const chunk = decoder.decode(next.value, { stream: true });
      buffer += chunk;
      allRaw += chunk;

      let eventBoundary = buffer.indexOf('\n\n');
      while (eventBoundary !== -1) {
        const rawEvent = buffer.slice(0, eventBoundary);
        buffer = buffer.slice(eventBoundary + 2);

        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim());
        if (dataLines.length > 0) {
          const dataStr = dataLines.join('\n');
          try {
            const parsed = JSON.parse(dataStr) as JsonRpcResponse;
            if (parsed.id === targetId) {
              result = parsed;
              break;
            }
            if (parsed.error && parsed.id === null) {
              result = parsed;
              break;
            }
          } catch {
            /* skip non-JSON events */
          }
        }
        eventBoundary = buffer.indexOf('\n\n');
      }

      if (result !== null) break;
    }
  } finally {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  return { parsed: result, raw: allRaw };
}

function parseToolResult<T>(rpc: RpcOutcome): T {
  if (rpc.body === null) throw new Error(`No body in RPC response: ${rpc.rawText}`);
  if (rpc.body.error) {
    throw new Error(`RPC error ${String(rpc.body.error.code)}: ${rpc.body.error.message}`);
  }
  const result = rpc.body.result as {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: T;
  };
  if (result.structuredContent) return result.structuredContent;
  if (result.content && result.content[0]) {
    return JSON.parse(result.content[0].text) as T;
  }
  throw new Error(`Unparseable tool result: ${JSON.stringify(rpc.body)}`);
}

describe('MCP smoke E2E (PRY-006 Slice 0)', () => {
  let world: SmokeWorld;

  beforeEach(async () => {
    world = await seedSmokeWorld();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  it('healthz responds 200 ok', async () => {
    const res = await fetch(`${world.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('readyz responds 200 ready', async () => {
    const res = await fetch(`${world.baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ready' });
  });

  it('jwks.json exposes the signing key set', async () => {
    const res = await fetch(`${world.baseUrl}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { keys: Array<{ kty: string; kid: string }> };
    expect(body.keys.length).toBe(1);
    expect(body.keys[0]?.kty).toBe('OKP');
  });

  it('rejects cross-session identity hijack (Bob reusing Alice session id → 403)', async () => {
    // 1. Alice initialises a session.
    const initA = await rpc(world.baseUrl, world.jwtA, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hijack-victim', version: '0' },
      },
    });
    expect(initA.status).toBe(200);
    const sessionA = initA.sessionId as string;
    expect(sessionA).toBeTruthy();
    await sendNotification(world.baseUrl, world.jwtA, 'notifications/initialized', sessionA);

    // 2. Bob (different valid identity) sends a request reusing Alice's session id.
    //    Defense MUST reject with 403 forbidden BEFORE the request reaches the
    //    SDK transport — otherwise Bob would act as Alice on subsequent tool calls.
    const res = await fetch(`${world.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${world.jwtB}`,
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'get_agent_config', arguments: {} },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32002);
    expect(body.error?.message).toBe('forbidden');
  });

  it('rejects initialize without Bearer token (401)', async () => {
    const res = await fetch(`${world.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke-no-auth', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32001);
  });

  it('AC1: full roundtrip — initialize → get_agent_config → send → check_unread → read_mailbox → mark_read → re-read', async () => {
    // ── Step 5a: client A initialize ──
    const initA = await rpc(world.baseUrl, world.jwtA, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-a', version: '0.1' },
      },
    });
    expect(initA.status).toBe(200);
    expect(initA.sessionId).toBeTruthy();
    const sessionA = initA.sessionId as string;

    // Send the `notifications/initialized` to complete the MCP handshake.
    await sendNotification(world.baseUrl, world.jwtA, 'notifications/initialized', sessionA);

    // ── Step 5b: get_agent_config (worker-a) ──
    const cfgA = await rpc(
      world.baseUrl,
      world.jwtA,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_agent_config', arguments: {} },
      },
      sessionA,
    );
    const cfg = parseToolResult<{
      participant_id: string;
      kind: string;
      hive_id: string;
      colony_id: string;
      owner_id?: string;
      capabilities?: string[];
    }>(cfgA);
    expect(cfg.kind).toBe('worker');
    expect(cfg.participant_id).toBe(world.workerAId);
    expect(cfg.owner_id).toBeTruthy();
    expect(cfg.capabilities).toContain('cell.send');

    // ── Step 6: client B initialize ──
    const initB = await rpc(world.baseUrl, world.jwtB, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-b', version: '0.1' },
      },
    });
    expect(initB.status).toBe(200);
    expect(initB.sessionId).toBeTruthy();
    const sessionB = initB.sessionId as string;
    await sendNotification(world.baseUrl, world.jwtB, 'notifications/initialized', sessionB);

    // ── Step 7: client A send_message → worker-b ──
    const sendRpc = await rpc(
      world.baseUrl,
      world.jwtA,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'send_message',
          arguments: {
            recipient: world.workerBId,
            type: 'notification',
            body: 'hello from A',
          },
        },
      },
      sessionA,
    );
    const sendResult = parseToolResult<{
      message_id: string;
      sent_at: string;
      delivered_at: string;
      replayed: boolean;
    }>(sendRpc);
    expect(sendResult.message_id).toMatch(/^[0-9a-f]{8}-/);
    expect(sendResult.replayed).toBe(false);

    // ── Step 8a: client B check_unread_messages ──
    const checkRpc = await rpc(
      world.baseUrl,
      world.jwtB,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'check_unread_messages', arguments: {} },
      },
      sessionB,
    );
    const summary = parseToolResult<{ unread_count: number; sender_ids: string[] }>(checkRpc);
    expect(summary.unread_count).toBe(1);
    expect(summary.sender_ids).toEqual([world.workerAId]);

    // ── Step 8b: client B read_mailbox → message in 'delivered' state ──
    const readRpc = await rpc(
      world.baseUrl,
      world.jwtB,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_mailbox', arguments: {} },
      },
      sessionB,
    );
    const readResult = parseToolResult<{
      messages: Array<{
        id: string;
        from: string;
        to: string;
        type: string;
        body: string;
        state: string;
      }>;
      next_cursor: unknown;
    }>(readRpc);
    expect(readResult.messages).toHaveLength(1);
    expect(readResult.messages[0]?.state).toBe('delivered');
    expect(readResult.messages[0]?.from).toBe(world.workerAId);
    expect(readResult.messages[0]?.body).toBe('hello from A');
    const messageId = readResult.messages[0]?.id as string;

    // ── Step 8c: client B mark_read → marked: [id] ──
    const markRpc = await rpc(
      world.baseUrl,
      world.jwtB,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'mark_read', arguments: { message_ids: [messageId] } },
      },
      sessionB,
    );
    const markResult = parseToolResult<{ marked: string[]; ignored: string[] }>(markRpc);
    expect(markResult.marked).toEqual([messageId]);
    expect(markResult.ignored).toEqual([]);

    // ── Step 8d: client B read_mailbox → same message, state: 'read' ──
    const reReadRpc = await rpc(
      world.baseUrl,
      world.jwtB,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'read_mailbox', arguments: {} },
      },
      sessionB,
    );
    const reRead = parseToolResult<{
      messages: Array<{ id: string; state: string }>;
    }>(reReadRpc);
    expect(reRead.messages).toHaveLength(1);
    expect(reRead.messages[0]?.state).toBe('read');
  });
});
