// register_session against the production wire (ADR-026): real HTTP, the real SDK 2.x
// client, real credentials and real persistence. SQLite by default; set HIVE_TEST_PG_URL
// to run the same suite against Postgres (CI `postgres` job), where the concurrent
// requests race real transactions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Kysely } from 'kysely';

import {
  createEnrollment,
  createParticipantsReadRepo,
  type Enrollment,
  type UUIDv7,
} from '#domain/auth/index.js';
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

    // The loser of the unique index gets NAME_IN_USE; a request that looks the name up
    // after the winner committed claims it instead (creation reserves nothing). Either
    // way there is one Agent and no request fails otherwise.
    it('two concurrent registrations of a new name: one Agent, the other NAME_IN_USE or a claim', async () => {
      const { jwt } = await issueEnrollment();
      const args = { name: 'claude-race', description: DESCRIPTION };

      const outcomes = await Promise.all([
        registerRaw(world, jwt, args),
        registerRaw(world, jwt, args),
      ]);

      for (const outcome of outcomes) expect([undefined, -32007]).toContain(errorCode(outcome));
      expect(outcomes.some((o) => o.error === undefined)).toBe(true);
      const rows = await db
        .selectFrom('agents')
        .select('id')
        .where('name', '=', 'claude-race')
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  describe('claimed', () => {
    it('claims an offline holder and supersedes its previous token', async () => {
      const { jwt } = await issueEnrollment();
      const first = await register(jwt);

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
      await register(jwt);

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

    it('leaves the retired branch failing as an internal error until revival exists', async () => {
      const { jwt } = await issueEnrollment();
      const registered = await register(jwt);
      await db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: new Date().toISOString() })
        .where('id', '=', registered.agent_id)
        .execute();

      const outcome = await registerRaw(world, jwt, {
        name: 'claude-api',
        description: DESCRIPTION,
      });

      expect(outcome.error).toEqual({ code: -32603, message: 'internal error' });
      // The reservation was released: nothing holds the name in memory.
      expect(
        world.wire._presenceRegistry().claimHolder(registered.agent_id, registered.agent_id),
      ).toEqual({ outcome: 'granted' });
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
