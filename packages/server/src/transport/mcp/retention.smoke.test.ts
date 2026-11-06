// PRY-094 (ADR-026) against the production wire: the retention job scheduled by the
// composition root, revival through register_session, delivery to a retired Agent and the
// replay on its revived stream. Real HTTP, the real SDK 2.x client and real persistence.
// SQLite by default; set HIVE_TEST_PG_URL to run the same suite against Postgres (CI
// `postgres` job), where the concurrent requests race real transactions.

import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Kysely } from 'kysely';

import {
  createEnrollment,
  createParticipantsReadRepo,
  type Enrollment,
  type UUIDv7,
} from '#domain/auth/index.js';
import type { AuditEventCategory } from '#domain/audit/index.js';
import { createLogger } from '#observability/logger.js';
import { createDb } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';
import { dateToIso } from '#persistence/type-mappers.js';

import { seedSmokeWorld, type SmokeWorld, type SmokeWorldOptions } from './smoke-world.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const PROTOCOL_VERSION = '2026-07-28';
const DAY_MS = 24 * 60 * 60 * 1000;
const DESCRIPTION = 'Works on the API';
const ARGS = { name: 'claude-api', description: DESCRIPTION };
const QUICK = { timeout: 3000, interval: 20 };

interface Registered {
  agent_ref: string;
  agent_id: UUIDv7;
  token: string;
  expires_at: string;
}

interface RawOutcome {
  status: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown } | undefined;
}

interface Waggle {
  kind: string;
  [key: string]: unknown;
}

async function registerRaw(
  world: SmokeWorld,
  jwt: string,
  args: Record<string, unknown> = ARGS,
): Promise<RawOutcome> {
  const res = await fetch(`${world.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${jwt}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'register_session',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'register_session',
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await res.text();
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '{}');
  return { status: res.status, ...(JSON.parse(json) as Omit<RawOutcome, 'status'>) };
}

async function connect(world: SmokeWorld, jwt: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${world.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${jwt}` } },
  });
  const client = new Client(
    { name: 'hive-retention-smoke', version: '0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

interface Listener {
  client: Client;
  waggles: Waggle[];
  closed: () => boolean;
}

async function listen(world: SmokeWorld, jwt: string): Promise<Listener> {
  const client = await connect(world, jwt);
  const waggles: Waggle[] = [];
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    const meta = notification.params._meta as { hiveWaggle?: Waggle } | undefined;
    if (meta?.hiveWaggle) waggles.push(meta.hiveWaggle);
  });
  const uri = (await client.listResources()).resources[0]?.uri as string;
  const subscription = await client.listen({ resourceSubscriptions: [uri] });
  let closed = false;
  void subscription.closed.then(
    () => (closed = true),
    () => (closed = true),
  );
  return { client, waggles, closed: () => closed };
}

describe(`retired Agents over HTTP (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SmokeWorld;
  let db: Kysely<Database>;
  let enrollment: Enrollment;
  let clients: Client[];
  let logLines: string[];

  async function start(options: SmokeWorldOptions = {}): Promise<void> {
    logLines = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        logLines.push(chunk.toString());
        cb();
      },
    });
    world = await seedSmokeWorld({
      ...(PG_URL !== undefined && { pgUrl: PG_URL }),
      logger: createLogger({ level: 'info', pretty: false }, sink),
      ...options,
    });
    db = createDb(world.dbConfig);
    enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(db, world.dbConfig.dialect),
      hiveStableIdentifier: world.hiveId,
      db,
      dialect: world.dbConfig.dialect,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
    });
  }

  beforeEach(() => {
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await db.destroy();
    await world.cleanup();
  });

  async function issueEnrollment(maxAgents?: number): Promise<{ jwt: string; jti: UUIDv7 }> {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.adminId, ...(maxAgents !== undefined && { maxAgents }) },
      { kind: 'system' },
    );
    return { jwt: issued.jwt, jti: issued.jti };
  }

  async function register(jwt: string, args: Record<string, unknown> = ARGS): Promise<Registered> {
    const outcome = await registerRaw(world, jwt, args);
    expect(outcome.error).toBeUndefined();
    return (outcome.result as { structuredContent: Registered }).structuredContent;
  }

  async function client(jwt: string): Promise<Client> {
    const created = await connect(world, jwt);
    clients.push(created);
    return created;
  }

  async function open(jwt: string): Promise<Listener> {
    const listener = await listen(world, jwt);
    clients.push(listener.client);
    return listener;
  }

  /** Opens and drops the listen stream: the Agent is offline from then on. */
  async function goOffline(registered: Registered): Promise<void> {
    const listener = await listen(world, registered.token);
    const registry = world.wire._presenceRegistry();
    await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(true);
    await listener.client.close();
    await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(false);
  }

  /** Moves the last connection back beyond HIVE_ENROLLMENT_RETENTION_DAYS (30). */
  async function backdate(agentId: UUIDv7, days = 31): Promise<void> {
    await db
      .updateTable('agents')
      .set({ last_connected_at: dateToIso(new Date(Date.now() - days * DAY_MS)) })
      .where('id', '=', agentId)
      .execute();
  }

  async function runJob() {
    const result = await world.wire._enrollmentRetention().runOnce();
    if (result === null) throw new Error('the retention run failed');
    return result;
  }

  async function agentState(agentId: UUIDv7): Promise<string> {
    const row = await db
      .selectFrom('agents')
      .select('state')
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow();
    return row.state;
  }

  async function retireOffline(jwt: string): Promise<Registered> {
    const registered = await register(jwt);
    await goOffline(registered);
    await backdate(registered.agent_id);
    expect((await runJob()).retiredAgentIds).toEqual([registered.agent_id]);
    return registered;
  }

  async function audit(category: AuditEventCategory) {
    return db.selectFrom('audit_log').selectAll().where('category', '=', category).execute();
  }

  describe('the scheduled job', () => {
    it('does not run at start: a stale Agent stays active until the first interval', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await goOffline(registered);
      await backdate(registered.agent_id, 400);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(await agentState(registered.agent_id)).toBe('active');
    });

    it('retires an offline enrollment Agent with agent_retired by system, never a manual one', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await goOffline(registered);
      await backdate(registered.agent_id);
      await backdate(world.workerAId, 400);

      const result = await runJob();

      expect(result.retiredAgentIds).toEqual([registered.agent_id]);
      expect(await agentState(world.workerAId)).toBe('active');
      const rows = await audit('agent_retired');
      expect(rows.map((r) => [r.actor_id, r.actor_kind, r.subject_id])).toEqual([
        [null, 'system', registered.agent_id],
      ]);
    });

    it('never retires a holder with an open stream, however old its last connection', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await open(registered.token);
      await expect
        .poll(() => world.wire._presenceRegistry().isHolderLive(registered.agent_id))
        .toBe(true);
      await backdate(registered.agent_id, 90);

      const result = await runJob();

      expect(result.retiredAgentIds).toEqual([]);
      expect(await agentState(registered.agent_id)).toBe('active');
    });

    it('wire.stop() waits for the run in progress', async () => {
      await start();
      const order: string[] = [];
      const run = world.wire
        ._enrollmentRetention()
        .runOnce()
        .then(() => order.push('run'));

      await world.wire.stop().then(() => order.push('stop'));
      await run;

      expect(order).toEqual(['run', 'stop']);
    });

    it('a grace past due revokes the Agent, closes its Cell and frees the name', async () => {
      await start({ wire: { enrollmentGraceDays: 1 } });
      const { jwt } = await issueEnrollment();
      const registered = await retireOffline(jwt);
      await db
        .updateTable('agents')
        .set({ retired_at: dateToIso(new Date(Date.now() - 2 * DAY_MS)) })
        .where('id', '=', registered.agent_id)
        .execute();

      expect((await runJob()).revokedAgentIds).toEqual([registered.agent_id]);

      expect(await agentState(registered.agent_id)).toBe('revoked');
      const cell = await db
        .selectFrom('cells')
        .select('state')
        .where('owner_id', '=', registered.agent_id)
        .executeTakeFirstOrThrow();
      expect(cell.state).toBe('closed');
      const revokes = await audit('admin_agent_revoke');
      expect(revokes.map((r) => [r.actor_kind, r.subject_id, r.reason_code])).toEqual([
        ['system', registered.agent_id, 'enrollment_grace_expired'],
      ]);
      const fresh = await register(jwt);
      expect(fresh.agent_id).not.toBe(registered.agent_id);
    });
  });

  describe('revival through register_session', () => {
    it('revives the same Agent and Cell with agent_revived; the token from before no longer serves', async () => {
      await start();
      const { jwt, jti } = await issueEnrollment();
      const retired = await retireOffline(jwt);
      const cellBefore = await db
        .selectFrom('cells')
        .select(['id', 'state'])
        .where('owner_id', '=', retired.agent_id)
        .executeTakeFirstOrThrow();

      const revived = await register(jwt, { ...ARGS, description: 'Back on the API' });

      expect(revived.agent_id).toBe(retired.agent_id);
      expect(await agentState(retired.agent_id)).toBe('active');
      const cellAfter = await db
        .selectFrom('cells')
        .select(['id', 'state'])
        .where('owner_id', '=', retired.agent_id)
        .executeTakeFirstOrThrow();
      expect(cellAfter).toEqual(cellBefore);
      expect(cellAfter.state).toBe('active');
      const rows = await audit('agent_revived');
      expect(rows.map((r) => [r.actor_id, r.actor_kind, r.subject_id])).toEqual([
        [world.adminId, 'hivekeeper', retired.agent_id],
      ]);
      expect(JSON.parse(rows[0]?.detail as string)).toEqual({
        enrolledVia: jti,
        retiredAt: expect.any(String) as unknown,
        viaEnrollmentJti: jti,
      });
      const stale = await registerRaw(world, retired.token);
      expect(stale.error?.code).toBe(-32001);
      const fresh = await client(revived.token);
      await expect(fresh.callTool({ name: 'get_agent_config', arguments: {} })).resolves.toEqual(
        expect.objectContaining({ structuredContent: expect.any(Object) as unknown }),
      );
      expect(logLines.join('')).toContain('"outcome":"revived"');
    });

    it('answers ENROLLMENT_QUOTA_EXCEEDED when the enrollment is full; the Agent stays retired', async () => {
      await start();
      const { jwt } = await issueEnrollment(1);
      const retired = await retireOffline(jwt);
      await register(jwt, { name: 'claude-web', description: DESCRIPTION });

      const outcome = await registerRaw(world, jwt);

      expect(outcome.error).toEqual({
        code: -32010,
        message: 'enrollment quota exceeded',
        data: { limit: 1 },
      });
      expect(await agentState(retired.agent_id)).toBe('retired');
      // The reservation was released.
      expect(
        world.wire._presenceRegistry().claimHolder(retired.agent_id, retired.agent_id),
      ).toEqual({ outcome: 'granted' });
    });

    it('a send to the retired Agent is stored, and the revived holder gets the replay', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const retired = await retireOffline(jwt);
      const sender = await client(world.jwtA);

      const sent = await sender.callTool({
        name: 'send_message',
        arguments: { recipient: retired.agent_id, type: 'request', body: 'while you were away' },
      });

      expect(sent.isError ?? false).toBe(false);
      expect(sent.structuredContent).toMatchObject({ stored_at: expect.any(String) as unknown });

      const revived = await register(jwt);
      const holder = await open(revived.token);
      await vi.waitFor(() => {
        expect(holder.waggles[0]).toMatchObject({ kind: 'replay', unread_count: 1 });
      }, QUICK);
    });

    it('get_agent_status reports a retired Agent offline with its last connection', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const retired = await retireOffline(jwt);
      const owner = await client(world.jwtAdmin);

      const status = await owner.callTool({
        name: 'get_agent_status',
        arguments: { participant: retired.agent_id },
      });

      expect(status.structuredContent).toMatchObject({
        participant_id: retired.agent_id,
        presence: 'offline',
        last_connected_at: expect.any(String) as unknown,
      });
    });

    it('list_agents hides retired Agents unless include_retired is set', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const retired = await retireOffline(jwt);
      const owner = await client(world.jwtAdmin);
      const ids = async (filter: Record<string, unknown>) => {
        const listed = await owner.callTool({ name: 'list_agents', arguments: { filter } });
        return (listed.structuredContent as { agents: { id: string; state: string }[] }).agents;
      };

      expect((await ids({})).map((a) => a.id)).not.toContain(retired.agent_id);
      expect(await ids({ include_retired: true })).toContainEqual(
        expect.objectContaining({ id: retired.agent_id, state: 'retired' }),
      );
    });

    // A claim racing the job: either the claim refreshes the row first and the job loses,
    // or the job retires first and the registration revives. Exactly one of the two.
    it('a registration racing the job always ends active, through exactly one path', async () => {
      await start();
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await goOffline(registered);
      await backdate(registered.agent_id);

      const [outcome, result] = await Promise.all([registerRaw(world, jwt), runJob()]);

      expect(outcome.error).toBeUndefined();
      expect(await agentState(registered.agent_id)).toBe('active');
      const claimed = await audit('agent_claimed');
      const revived = await audit('agent_revived');
      if (result.retiredAgentIds.length === 0) {
        expect([claimed.length, revived.length]).toEqual([1, 0]);
      } else {
        expect(result.retiredAgentIds).toEqual([registered.agent_id]);
        expect([claimed.length, revived.length]).toEqual([0, 1]);
      }
    });
  });

  describe('a release of the holder tokens from another process', () => {
    it('drops the live stream on the next re-verification, blocks the renewal and frees the name', async () => {
      await start({ wire: { reverifyIntervalSeconds: 1 } });
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      const holder = await open(registered.token);
      const registry = world.wire._presenceRegistry();
      await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(true);
      expect((await registerRaw(world, jwt)).error?.code).toBe(-32007);

      // What `hivectl agent release` runs, in its own process.
      const released = await enrollment.revokeWorkerTokens(
        { agentId: registered.agent_id, revokedBy: world.adminId, reason: 'agent_release' },
        { kind: 'system' },
      );
      expect(released.revokedTokenJtis).toHaveLength(1);

      await expect.poll(() => holder.closed(), { timeout: 4000 }).toBe(true);
      await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(false);
      expect((await registerRaw(world, registered.token)).error?.code).toBe(-32001);
      const claimed = await register(jwt);
      expect(claimed.agent_id).toBe(registered.agent_id);
    }, 10_000);
  });

  describe('a retired Agent with an open stream', () => {
    it('is cut by the re-verification pass with participant_retired', async () => {
      await start({ wire: { reverifyIntervalSeconds: 1 } });
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      const holder = await open(registered.token);
      await expect
        .poll(() => world.wire._presenceRegistry().isHolderLive(registered.agent_id))
        .toBe(true);

      // Retired from outside the server process, so only the re-verification sees it.
      await db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: dateToIso(new Date()) })
        .where('id', '=', registered.agent_id)
        .execute();

      await expect.poll(() => holder.closed(), { timeout: 4000 }).toBe(true);
      await vi.waitFor(() => {
        expect(logLines.join('')).toContain('"closeReason":"participant_retired"');
      }, QUICK);
      expect(world.wire._presenceRegistry().isHolderLive(registered.agent_id)).toBe(false);
    }, 10_000);
  });
});
