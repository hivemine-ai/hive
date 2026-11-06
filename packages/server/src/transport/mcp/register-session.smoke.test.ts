// register_session against the production wire (ADR-026): real HTTP, the real SDK 2.x
// client, real credentials and real persistence. SQLite by default; set HIVE_TEST_PG_URL
// to run the same suite against Postgres (CI `postgres` job), where the concurrent
// requests race real transactions.

import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Kysely } from 'kysely';

import {
  createEnrollment,
  createParticipantsReadRepo,
  createRevoker,
  type Enrollment,
  type UUIDv7,
} from '#domain/auth/index.js';
import { createLogger } from '#observability/logger.js';
import { createDb } from '#persistence/db.js';
import type { Database } from '#persistence/schema.js';

import { seedSmokeWorld, type SmokeWorld } from './smoke-world.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const PROTOCOL_VERSION = '2026-07-28';
const DAY_MS = 24 * 60 * 60 * 1000;
const DESCRIPTION = 'Works on the API';

interface Registered {
  agent_ref: string;
  agent_id: UUIDv7;
  token: string;
  expires_at: string;
}

interface RawOutcome {
  status: number;
  headers: Headers;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown } | undefined;
}

/** One JSON-RPC request over plain fetch, so the HTTP status stays visible. */
async function raw(
  world: SmokeWorld,
  jwt: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RawOutcome> {
  const name = params['name'];
  const res = await fetch(`${world.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${jwt}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof name === 'string' && { 'mcp-name': name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
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
  const body = JSON.parse(json) as { result?: unknown; error?: RawOutcome['error'] };
  return { status: res.status, headers: res.headers, ...body };
}

function registerRaw(
  world: SmokeWorld,
  jwt: string,
  args: Record<string, unknown>,
): Promise<RawOutcome> {
  return raw(world, jwt, 'tools/call', { name: 'register_session', arguments: args });
}

async function connect(world: SmokeWorld, jwt: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${world.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${jwt}` } },
  });
  const client = new Client(
    { name: 'hive-register-smoke', version: '0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

/**
 * The holder opens its listen stream (which consumes the reservation of its create or
 * claim) and then drops it: the Agent is offline and claimable from then on.
 */
async function goOffline(world: SmokeWorld, registered: Registered): Promise<void> {
  const holder = await connect(world, registered.token);
  const uri = (await holder.listResources()).resources[0]?.uri as string;
  await holder.listen({ resourceSubscriptions: [uri] });
  const registry = world.wire._presenceRegistry();
  await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(true);
  await holder.close();
  await expect.poll(() => registry.isHolderLive(registered.agent_id)).toBe(false);
}

describe(`register_session over HTTP (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SmokeWorld;
  let db: Kysely<Database>;
  let enrollment: Enrollment;
  let clients: Client[];

  beforeEach(async () => {
    world = await seedSmokeWorld({ ...(PG_URL !== undefined && { pgUrl: PG_URL }) });
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
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await db.destroy();
    await world.cleanup();
  });

  async function issueEnrollment(
    claims: { namePrefix?: string; maxAgents?: number } = {},
  ): Promise<{ jwt: string; jti: UUIDv7 }> {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.adminId, ...claims },
      { kind: 'system' },
    );
    return { jwt: issued.jwt, jti: issued.jti };
  }

  async function client(jwt: string): Promise<Client> {
    const created = await connect(world, jwt);
    clients.push(created);
    return created;
  }

  async function register(
    jwt: string,
    args: Record<string, unknown> = { name: 'claude-api', description: DESCRIPTION },
  ): Promise<Registered> {
    const outcome = await registerRaw(world, jwt, args);
    expect(outcome.error).toBeUndefined();
    return (outcome.result as { structuredContent: Registered }).structuredContent;
  }

  function errorCode(outcome: RawOutcome): number | undefined {
    return outcome.error?.code;
  }

  describe('enroll scope binding', () => {
    it('answers 403 -32006 for tools/list, other tools, resources/read and subscriptions/listen', async () => {
      const { jwt } = await issueEnrollment();

      for (const [method, params] of [
        ['tools/list', {}],
        ['tools/call', { name: 'get_agent_config', arguments: {} }],
        ['resources/read', { uri: 'hive://cells/x' }],
        ['subscriptions/listen', { notifications: { toolsListChanged: true } }],
      ] as const) {
        const outcome = await raw(world, jwt, method, params);
        expect(outcome.status, method).toBe(403);
        expect(outcome.error, method).toEqual({ code: -32006, message: 'credential out of scope' });
      }
    });

    it('lets the SDK client connect (server/discover) and call register_session', async () => {
      const { jwt } = await issueEnrollment();
      const enrolled = await client(jwt);

      const result = await enrolled.callTool({
        name: 'register_session',
        arguments: { name: 'claude-api', description: DESCRIPTION },
      });

      const registered = result.structuredContent as Registered;
      expect(registered.agent_ref).toBe('claude-api@admin.smoke');
      expect(Date.parse(registered.expires_at)).toBeGreaterThan(Date.now());
    });
  });

  describe('created', () => {
    it('writes the Agent, its Worker token and its Cell, and the token works as a Worker', async () => {
      const { jwt, jti } = await issueEnrollment();

      const registered = await register(jwt);

      const agent = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', registered.agent_id)
        .executeTakeFirstOrThrow();
      expect(agent).toMatchObject({
        name: 'claude-api',
        type: 'worker',
        state: 'active',
        origin: 'enrollment',
        enrolled_via: jti,
        description: DESCRIPTION,
      });
      const cell = await db
        .selectFrom('cells')
        .select('state')
        .where('owner_id', '=', registered.agent_id)
        .executeTakeFirst();
      expect(cell?.state).toBe('active');
      const token = await db
        .selectFrom('credentials')
        .select('enrolled_via')
        .where('jti', '=', agent.last_worker_jti as string)
        .executeTakeFirstOrThrow();
      expect(token.enrolled_via).toBe(jti);

      const worker = await client(registered.token);
      const config = await worker.callTool({ name: 'get_agent_config', arguments: {} });
      expect((config.structuredContent as { participant_id: string }).participant_id).toBe(
        registered.agent_id,
      );
    });

    // Spec: the loser gets NAME_IN_USE, whether it lost the unique index or looked the
    // name up after the winner committed (the creator holds the reservation).
    it('two concurrent registrations of a new name: exactly one created, the other NAME_IN_USE', async () => {
      const { jwt } = await issueEnrollment();
      const args = { name: 'claude-race', description: DESCRIPTION };

      const outcomes = await Promise.all([
        registerRaw(world, jwt, args),
        registerRaw(world, jwt, args),
      ]);

      expect(outcomes.map(errorCode).sort()).toEqual([-32007, undefined]);
      const rows = await db
        .selectFrom('agents')
        .select('id')
        .where('name', '=', 'claude-race')
        .execute();
      expect(rows).toHaveLength(1);
      expect(
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('category', '=', 'agent_claimed')
          .execute(),
      ).toHaveLength(0);
    });

    it('a registration right after a create answers NAME_IN_USE until the creator opens its stream', async () => {
      const { jwt } = await issueEnrollment();
      const created = await register(jwt);
      const args = { name: 'claude-api', description: DESCRIPTION };

      expect(errorCode(await registerRaw(world, jwt, args))).toBe(-32007);

      await goOffline(world, created);
      expect((await registerRaw(world, jwt, args)).error).toBeUndefined();
    });
  });

  describe('claimed', () => {
    it('claims an offline holder and supersedes its previous token', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);
      await goOffline(world, first);

      const second = await register(jwt);

      expect(second.agent_id).toBe(first.agent_id);
      expect(second.token).not.toBe(first.token);
      const stale = await raw(world, first.token, 'tools/call', {
        name: 'get_agent_config',
        arguments: {},
      });
      expect(stale.status).toBe(401);
      expect(stale.error?.code).toBe(-32001);
      const fresh = await raw(world, second.token, 'tools/call', {
        name: 'get_agent_config',
        arguments: {},
      });
      expect(fresh.error).toBeUndefined();
    });

    it('two concurrent claims of the same offline holder: one granted, the other NAME_IN_USE', async () => {
      const { jwt } = await issueEnrollment();
      await goOffline(world, await register(jwt));

      const args = { name: 'claude-api', description: DESCRIPTION };

      const outcomes = await Promise.all([
        registerRaw(world, jwt, args),
        registerRaw(world, jwt, args),
      ]);

      expect(outcomes.map(errorCode).sort()).toEqual([-32007, undefined]);
    });

    it('answers NAME_IN_USE while the holder keeps a listen stream open', async () => {
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      const holder = await client(registered.token);
      const uri = (await holder.listResources()).resources[0]?.uri as string;
      await holder.listen({ resourceSubscriptions: [uri] });
      await expect
        .poll(() => world.wire._presenceRegistry().isHolderLive(registered.agent_id))
        .toBe(true);

      const outcome = await registerRaw(world, jwt, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.error?.code).toBe(-32007);
    });
  });

  describe('rejections', () => {
    it('answers NAME_TAKEN for the name of a manual Agent of the owner', async () => {
      const { jwt } = await issueEnrollment();

      const outcome = await registerRaw(world, jwt, { name: 'worker-a', description: DESCRIPTION });

      expect(outcome.status).toBe(200);
      expect(outcome.error).toEqual({ code: -32008, message: 'name taken' });
    });

    it('answers AGENT_SUSPENDED for a suspended enrollment Agent', async () => {
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await db
        .updateTable('agents')
        .set({ state: 'suspended' })
        .where('id', '=', registered.agent_id)
        .execute();

      const outcome = await registerRaw(world, jwt, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.error).toEqual({ code: -32009, message: 'agent suspended' });
    });

    it('answers ENROLLMENT_QUOTA_EXCEEDED with the limit in error.data', async () => {
      const { jwt } = await issueEnrollment({ maxAgents: 1 });
      await register(jwt);

      const outcome = await registerRaw(world, jwt, {
        name: 'claude-web',
        description: DESCRIPTION,
      });

      expect(outcome.error).toEqual({
        code: -32010,
        message: 'enrollment quota exceeded',
        data: { limit: 1 },
      });
    });

    it.each([
      ['a malformed name', { name: 'Claude API', description: DESCRIPTION }, undefined],
      ['a name outside the prefix', { name: 'other-api', description: DESCRIPTION }, 'claude-'],
      ['a multi-line description', { name: 'claude-api', description: 'a\nb' }, undefined],
      [
        'a description over 280 characters',
        { name: 'claude-api', description: 'x'.repeat(281) },
        undefined,
      ],
    ])('answers -32602 for %s', async (_label, args, namePrefix) => {
      const { jwt } = await issueEnrollment(namePrefix !== undefined ? { namePrefix } : {});

      const outcome = await registerRaw(world, jwt, args);

      expect(outcome.error?.code).toBe(-32602);
    });
  });

  describe('renewed', () => {
    it('renews with the last token as Bearer, updates the description, keeps the old token valid', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);

      const renewed = await register(first.token, {
        name: 'claude-api',
        description: 'Now on the web app',
        capabilities: ['web'],
      });

      expect(renewed.agent_id).toBe(first.agent_id);
      const agent = await db
        .selectFrom('agents')
        .select(['description', 'capabilities', 'last_worker_jti'])
        .where('id', '=', first.agent_id)
        .executeTakeFirstOrThrow();
      expect(agent.description).toBe('Now on the web app');
      expect(JSON.parse(agent.capabilities)).toEqual(['web']);
      // A renewal supersedes nothing: the previous token still works as a Bearer.
      const old = await raw(world, first.token, 'tools/call', {
        name: 'get_agent_config',
        arguments: {},
      });
      expect(old.error).toBeUndefined();
      // But it is no longer the proof of a renewal.
      const replay = await registerRaw(world, first.token, {
        name: 'claude-api',
        description: DESCRIPTION,
      });
      expect(replay.status).toBe(401);
      expect(replay.error?.code).toBe(-32001);
    });

    it('accepts the last token expired inside the holder-proof window', async () => {
      const { jwt, jti } = await issueEnrollment();
      const first = await register(jwt);
      const expired = await enrollment.issueWorkerToken({
        agentId: first.agent_id,
        mode: 'claim',
        enrolledVia: jti,
        ttl: -60_000,
      });

      const renewed = await register(expired.jwt);

      expect(renewed.agent_id).toBe(first.agent_id);
    });

    it('rejects the last token expired beyond the window with -32001', async () => {
      const { jwt, jti } = await issueEnrollment();
      const first = await register(jwt);
      const ancient = await enrollment.issueWorkerToken({
        agentId: first.agent_id,
        mode: 'claim',
        enrolledVia: jti,
        ttl: -8 * DAY_MS,
      });

      const outcome = await registerRaw(world, ancient.jwt, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.status).toBe(401);
      expect(outcome.error?.code).toBe(-32001);
    });

    it('two concurrent renewals with the same token: exactly one wins', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);
      const args = { name: 'claude-api', description: DESCRIPTION };

      const outcomes = await Promise.all([
        registerRaw(world, first.token, args),
        registerRaw(world, first.token, args),
      ]);

      expect(outcomes.map(errorCode).sort()).toEqual([-32001, undefined]);
    });

    it('rejects the renewal of a suspended Agent with -32001', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);
      await db
        .updateTable('agents')
        .set({ state: 'suspended' })
        .where('id', '=', first.agent_id)
        .execute();

      const outcome = await registerRaw(world, first.token, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.status).toBe(401);
      expect(outcome.error?.code).toBe(-32001);
    });

    it('rejects another name with -32602 (renewal_name_mismatch)', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);

      const outcome = await registerRaw(world, first.token, {
        name: 'claude-web',
        description: DESCRIPTION,
      });

      expect(outcome.error?.code).toBe(-32602);
    });

    it('rejects a Hivekeeper token as a holder proof with -32001', async () => {
      const outcome = await registerRaw(world, world.jwtAdmin, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.status).toBe(401);
    });
  });

  describe('owner notices and the system sender', () => {
    async function auditRows(
      category: 'enrollment_reject_alert' | 'agent_enrolled' | 'agent_claimed',
    ) {
      return db.selectFrom('audit_log').selectAll().where('category', '=', category).execute();
    }

    it('five rejections of one name: one enrollment_reject_alert and one notice in the owner Cell', async () => {
      const { jwt, jti } = await issueEnrollment();
      const owner = await client(world.jwtAdmin);
      const before = await owner.callTool({ name: 'check_unread_messages', arguments: {} });
      const unreadBefore = (before.structuredContent as { unread_count: number }).unread_count;

      for (let i = 0; i < 6; i += 1) {
        const outcome = await registerRaw(world, jwt, {
          name: 'worker-a',
          description: DESCRIPTION,
        });
        expect(outcome.error?.code).toBe(-32008);
      }

      const alerts = await auditRows('enrollment_reject_alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        decision: 'deny',
        actor_id: world.adminId,
        actor_kind: 'hivekeeper',
        subject_id: world.workerAId,
      });
      expect(JSON.parse(alerts[0]?.detail as string)).toEqual({
        name: 'worker-a',
        rejections: 5,
        windowMinutes: 10,
        enrolledVia: jti,
        viaEnrollmentJti: jti,
      });
      const after = await owner.callTool({ name: 'check_unread_messages', arguments: {} });
      const summary = after.structuredContent as { unread_count: number; sender_ids: string[] };
      expect(summary.unread_count).toBe(unreadBefore + 1);
      expect(summary.sender_ids).toContain('system');
      expect(summary.sender_ids).not.toContain(world.hiveId);
    });

    it('a created Agent is announced once; the notice reads as system and cannot be answered', async () => {
      const { jwt, jti } = await issueEnrollment();
      const registered = await register(jwt);
      await goOffline(world, registered);
      await register(jwt); // a claim: no second notice

      const owner = await client(world.jwtAdmin);
      const mailbox = await owner.callTool({ name: 'read_mailbox', arguments: {} });
      const notices = (
        mailbox.structuredContent as {
          messages: {
            id: string;
            from: string;
            from_kind?: string;
            body: string;
            action: unknown;
          }[];
        }
      ).messages.filter((m) => m.from === 'system');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        from_kind: 'system',
        body: `Hive: new session agent ${registered.agent_ref} registered via enrollment credential ${jti}.`,
        action: { kind: 'agent_enrolled', agentRef: registered.agent_ref, enrolledVia: jti },
      });

      const reply = await raw(world, world.jwtAdmin, 'tools/call', {
        name: 'reply_to',
        arguments: { message_id: notices[0]?.id, type: 'response', body: 'thanks' },
      });
      expect(reply.error).toEqual({ code: -32004, message: 'recipient is not reachable' });
    });
  });

  describe('audit and discovery', () => {
    it('records agent_enrolled and agent_claimed with the owner as actor', async () => {
      const { jwt, jti } = await issueEnrollment();
      const registered = await register(jwt);
      await goOffline(world, registered);
      await register(jwt);

      const rows = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('category', 'in', ['agent_enrolled', 'agent_claimed'])
        .orderBy('id')
        .execute();
      expect(rows.map((r) => [r.category, r.actor_id, r.actor_kind, r.subject_id])).toEqual([
        ['agent_enrolled', world.adminId, 'hivekeeper', registered.agent_id],
        ['agent_claimed', world.adminId, 'hivekeeper', registered.agent_id],
      ]);
      expect(JSON.parse(rows[0]?.detail as string)).toEqual({
        agentRef: registered.agent_ref,
        enrolledVia: jti,
        viaEnrollmentJti: jti,
      });
      expect(JSON.parse(rows[1]?.detail as string)).toEqual({
        enrolledVia: jti,
        previousEnrolledVia: jti,
        viaEnrollmentJti: jti,
      });
    });

    it('shows the description in get_agent_config, list_agents and get_agent_status', async () => {
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      const worker = await client(registered.token);
      const owner = await client(world.jwtAdmin);

      const config = await worker.callTool({ name: 'get_agent_config', arguments: {} });
      expect((config.structuredContent as { description: string }).description).toBe(DESCRIPTION);
      const listed = await owner.callTool({ name: 'list_agents', arguments: {} });
      const agents = (listed.structuredContent as { agents: { id: string; description: string }[] })
        .agents;
      expect(agents.find((a) => a.id === registered.agent_id)?.description).toBe(DESCRIPTION);
      expect(agents.find((a) => a.id === world.workerAId)?.description).toBe('');
      const status = await owner.callTool({
        name: 'get_agent_status',
        arguments: { participant: registered.agent_id },
      });
      expect((status.structuredContent as { description: string }).description).toBe(DESCRIPTION);
    });
  });

  it('is caught by ProtocolError in the SDK client with the wire code', async () => {
    const { jwt } = await issueEnrollment();
    const enrolled = await client(jwt);

    const err = await enrolled
      .callTool({ name: 'register_session', arguments: { name: 'worker-a', description: 'x' } })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe(-32008);
  });
});

// A renewal re-binds the open listen stream of the Agent to the new token (ADR-026): the
// stream does not close at the `exp` of the token it was opened with and the Agent stays
// online; a later revocation of the enrollment still closes it on the next pass.
describe(`register_session renewal and the listen stream (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  const TTL_MS = 4000;
  let world: SmokeWorld;
  let db: Kysely<Database>;
  let clients: Client[];

  beforeEach(async () => {
    world = await seedSmokeWorld({
      ...(PG_URL !== undefined && { pgUrl: PG_URL }),
      wire: { workerTokenTtlMs: TTL_MS, reverifyIntervalSeconds: 1 },
    });
    db = createDb(world.dbConfig);
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await db.destroy();
    await world.cleanup();
  });

  it('keeps the stream open and online past the original exp, and closes it on revocation', async () => {
    const enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(db, world.dbConfig.dialect),
      hiveStableIdentifier: world.hiveId,
      db,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
    });
    const credential = await enrollment.issueEnrollmentCredential(
      { ownerId: world.adminId },
      { kind: 'system' },
    );
    const args = { name: 'claude-api', description: DESCRIPTION };
    const first = (
      (await registerRaw(world, credential.jwt, args)).result as { structuredContent: Registered }
    ).structuredContent;
    const firstExp = Date.parse(first.expires_at);

    const holder = await connect(world, first.token);
    clients.push(holder);
    const uri = (await holder.listResources()).resources[0]?.uri as string;
    const subscription = await holder.listen({ resourceSubscriptions: [uri] });
    let closed = false;
    void subscription.closed.then(
      () => (closed = true),
      () => (closed = true),
    );
    const registry = world.wire._presenceRegistry();
    await expect.poll(() => registry.isHolderLive(first.agent_id)).toBe(true);

    // Renew halfway, so the new exp lands clearly after the original one.
    await new Promise((resolve) => setTimeout(resolve, TTL_MS / 2));
    const renewal = await registerRaw(world, first.token, args);
    expect(renewal.error).toBeUndefined();
    const renewed = (renewal.result as { structuredContent: Registered }).structuredContent;
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(firstExp);

    // Past the exp of the token the stream was opened with.
    await new Promise((resolve) => setTimeout(resolve, firstExp - Date.now() + 400));
    expect(Date.now()).toBeLessThan(Date.parse(renewed.expires_at));
    expect(closed).toBe(false);
    expect(registry.isHolderLive(first.agent_id)).toBe(true);

    await createRevoker({ db }).revokeCredential({ jti: credential.jti, reason: 'leaked' });

    await expect.poll(() => registry.isHolderLive(first.agent_id), { timeout: 3000 }).toBe(false);
    await expect.poll(() => closed, { timeout: 3000 }).toBe(true);
  }, 15_000);
});

describe(`register_session rate limit (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SmokeWorld;
  let db: Kysely<Database>;

  beforeEach(async () => {
    world = await seedSmokeWorld({
      ...(PG_URL !== undefined && { pgUrl: PG_URL }),
      wire: { enrollmentRegisterRateLimit: 2, enrollmentRegisterRateWindowSeconds: 60 },
    });
    db = createDb(world.dbConfig);
  });

  afterEach(async () => {
    await db.destroy();
    await world.cleanup();
  });

  it('answers 429 with Retry-After and -32011 once the enrollment spent its window', async () => {
    const credential = await createEnrollment({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(db, world.dbConfig.dialect),
      hiveStableIdentifier: world.hiveId,
      db,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
    }).issueEnrollmentCredential({ ownerId: world.adminId }, { kind: 'system' });
    const args = { name: 'claude-api', description: DESCRIPTION };

    await registerRaw(world, credential.jwt, args);
    await registerRaw(world, credential.jwt, args);
    const limited = await registerRaw(world, credential.jwt, args);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.error).toEqual({ code: -32011, message: 'too many registrations' });
  });
});

// The token in the response of register_session must never reach the logs, whatever
// the level: the whole log stream of the wire is captured at trace.
describe(`register_session and the logs (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  it('never writes the token of a create, a claim or a renewal to any log line', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const world = await seedSmokeWorld({
      ...(PG_URL !== undefined && { pgUrl: PG_URL }),
      logger: createLogger({ level: 'trace', pretty: false }, sink),
    });
    const db = createDb(world.dbConfig);
    try {
      const credential = await createEnrollment({
        signingKey: world.signingKey,
        participantsRepo: createParticipantsReadRepo(db, world.dbConfig.dialect),
        hiveStableIdentifier: world.hiveId,
        db,
        enrollmentTtlMs: 90 * DAY_MS,
        hiveMaxAgents: 10,
      }).issueEnrollmentCredential({ ownerId: world.adminId }, { kind: 'system' });
      const args = { name: 'claude-api', description: DESCRIPTION };

      const tokens: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const outcome = await registerRaw(world, credential.jwt, args);
        const registered = (outcome.result as { structuredContent: Registered }).structuredContent;
        tokens.push(registered.token);
        if (i === 0) await goOffline(world, registered);
      }
      const renewal = await registerRaw(world, tokens[1] as string, args);
      tokens.push((renewal.result as { structuredContent: Registered }).structuredContent.token);

      const logs = lines.join('');
      expect(logs).toContain('mcp_register_session_succeeded');
      for (const token of tokens) {
        expect(token.length).toBeGreaterThan(20);
        expect(logs).not.toContain(token);
        // Nor its signature alone.
        expect(logs).not.toContain(token.split('.')[2] as string);
      }
    } finally {
      await db.destroy();
      await world.cleanup();
    }
  });
});
