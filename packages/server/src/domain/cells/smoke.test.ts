// End-to-end smoke test for PRY-003 (Cell Store + Message Persistence Slice 0).
//
// Exercises the full demoable Slice 0 path with REAL components:
//   - Real SQLite on disk (matches production deploy mode; per PRY-002 lessons
//     `:memory:` has different transaction semantics).
//   - Real participants write repo (createHivekeeper / createAgent) wired with
//     the REAL `createCellsHookAdapter` so each participant gets a Cell row in
//     the same TX as the participant write (B1 atomicity invariant).
//   - Real Issuer + Verifier (Ed25519) producing real `IdentityContext` objects.
//   - Real Sender + Reader against the Cell Store repo.
//   - Visibility STUB (`stubVisibilityEngine`) — PRY-008 will swap the real one.
//
// The world is constructed directly (no `performInit`) to keep the test focused
// on the Cell Store stack and to avoid coupling to the CLI bootstrap flow
// (covered by `cli/src/init.smoke.test.ts`). The trade-off is a few extra lines
// of seed code for clearer ownership of every input that reaches the SUT.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v7 as uuidv7 } from 'uuid';

import {
  buildJwkSet,
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createVerifier,
  generateKeypair,
  loadBlocklist,
  writeKeypairToDisk,
  type CallerContext,
  type IdentityContext,
  type ParticipantsWriteRepo,
  type SigningKey,
  type UUIDv7,
} from '#domain/auth/index.js';
import { createDb, type DbConfig } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';

import { createCellsHookAdapter } from '#composition/cells-hook-adapter.js';
import { stubVisibilityEngine } from '#composition/stubs.js';

import { createCellEvents } from './events.js';
import { createReader, type Reader } from './read.js';
import { createSender, type Sender } from './send.js';
import { createCellsRepo, type CellsRepo } from './repository.js';

const SYSTEM_CALLER: CallerContext = {
  kind: 'system',
  osUser: 'pry-003-smoke',
  operatorNote: 'pry-003 hito-14 e2e smoke',
};

interface AgentRecord {
  id: UUIDv7;
}

interface SmokeWorld {
  cleanup: () => Promise<void>;
  cellsRepo: CellsRepo;
  sender: Sender;
  reader: Reader;
  hiveId: UUIDv7;
  adminId: UUIDv7;
  workerA: AgentRecord;
  workerB: AgentRecord;
  workerC: AgentRecord;
  ctxA: IdentityContext;
  ctxB: IdentityContext;
  ctxC: IdentityContext;
}

async function seedSmokeWorld(): Promise<SmokeWorld> {
  // ── filesystem & db (real SQLite on disk per PRY-002 lessons) ──
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry003-smoke-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
  const keysDir = path.join(workDir, 'keys');
  const dbConfig: DbConfig = {
    dialect: 'sqlite',
    url: `sqlite:${dbPath}`,
    sqliteWal: false,
  };
  const db = createDb(dbConfig);
  await migrateToLatest(db);

  // ── signing key (real Ed25519, persisted to disk so JWKS could be reloaded) ──
  const signingKey: SigningKey = generateKeypair();
  await writeKeypairToDisk({ keysDir }, signingKey);
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

  // ── hive + colony (the two scaffolding rows that performInit would also create) ──
  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const now = new Date();
  await db
    .insertInto('hives')
    .values({ id: hiveId, name: 'Smoke Hive', created_at: dateToIso(now) })
    .execute();
  await db
    .insertInto('colonies')
    .values({
      id: colonyId,
      hive_id: hiveId,
      name: 'default',
      created_at: dateToIso(now),
    })
    .execute();

  // ── repos wired with the REAL cells hook adapter (B1 atomicity) ──
  const cellsRepo = createCellsRepo(db);
  const cellsHook = createCellsHookAdapter(cellsRepo);
  const writeRepo: ParticipantsWriteRepo = createParticipantsWriteRepo(db, { cellsHook });
  const readRepo = createParticipantsReadRepo(db);

  // ── admin Hivekeeper (this exercises the createHivekeeper TX wrap + cellsHook) ──
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

  // ── workers A, B, C — each via createAgent so the Cell row is created too ──
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
  const workerC = await writeRepo.createAgent(
    {
      hiveId,
      colonyId,
      ownerId: admin.id,
      name: 'worker-c',
      type: 'worker',
      capabilities: ['cell.send', 'cell.read'],
    },
    SYSTEM_CALLER,
  );

  // ── credentials (REAL JWTs) for each worker via the issuer ──
  const issuer = createIssuer({
    signingKey,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
    defaultTtlMs: 60_000,
    db,
  });
  const credA = await issuer.issueCredential({ participantId: workerA.id });
  const credB = await issuer.issueCredential({ participantId: workerB.id });
  const credC = await issuer.issueCredential({ participantId: workerC.id });

  // ── verifier (REAL) producing REAL IdentityContext from each JWT ──
  const blocklist = await loadBlocklist(db);
  const signingKeys = new Map<string, SigningKey>([[signingKey.kid, signingKey]]);
  // `buildJwkSet` is called for parity with how the API layer composes the
  // verifier — it surfaces any JWK serialization issue at seed time.
  buildJwkSet(signingKeys.values());
  const verifier = createVerifier({
    signingKeys,
    blocklist,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
  });
  const ctxA = await verifier.verify(`Bearer ${credA.jwt}`);
  const ctxB = await verifier.verify(`Bearer ${credB.jwt}`);
  const ctxC = await verifier.verify(`Bearer ${credC.jwt}`);

  // ── sender + reader with deps wired to the live repos ──
  const events = createCellEvents();
  const sender = createSender({
    cellsRepo,
    visibilityEngine: stubVisibilityEngine,
    events,
    db,
  });
  const reader = createReader({ cellsRepo, db });

  return {
    cellsRepo,
    sender,
    reader,
    hiveId,
    adminId: admin.id,
    workerA: { id: workerA.id },
    workerB: { id: workerB.id },
    workerC: { id: workerC.id },
    ctxA,
    ctxB,
    ctxC,
    cleanup: async () => {
      await db.destroy();
      await fs.rm(workDir, { recursive: true, force: true });
    },
  };
}

describe('PRY-003 Cell Store Slice 0 — smoke E2E', () => {
  let world: SmokeWorld;

  beforeEach(async () => {
    world = await seedSmokeWorld();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  // ── AC-1 step 1: admin Hivekeeper has a Cell after createHivekeeper ──
  it('14a. admin Hivekeeper has a Cell after createHivekeeper (B1 atomicity)', async () => {
    const cell = await world.cellsRepo.findCellByOwner(world.adminId);
    expect(cell).not.toBeNull();
    expect(cell?.ownerId).toBe(world.adminId);
    expect(cell?.ownerKind).toBe('hivekeeper');
    expect(cell?.state).toBe('active');
    expect(cell?.hiveId).toBe(world.hiveId);
  });

  // ── AC-1 step 2: createAgent creates the worker Cell ──
  it('14b. createAgent creates the worker Cells (workerA + workerB + workerC)', async () => {
    const cellA = await world.cellsRepo.findCellByOwner(world.workerA.id);
    const cellB = await world.cellsRepo.findCellByOwner(world.workerB.id);
    const cellC = await world.cellsRepo.findCellByOwner(world.workerC.id);
    expect(cellA?.ownerKind).toBe('agent');
    expect(cellA?.state).toBe('active');
    expect(cellB?.ownerKind).toBe('agent');
    expect(cellC?.ownerKind).toBe('agent');
  });

  // ── AC-1 step 4: workerA → workerB sendMessage → SendResult populated ──
  it('14c. workerA sends a notification to workerB → SendResult populated, replayed=false', async () => {
    const result = await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'hello',
    });
    expect(result.replayed).toBe(false);
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.sentAt).toBeInstanceOf(Date);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  // ── AC-1 step 5: workerB readMailbox returns the delivered message ──
  it('14d. workerB readMailbox shows the delivered message from workerA', async () => {
    await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'hello',
    });
    const messages = await world.reader.readMailbox({ callerContext: world.ctxB });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe(world.workerA.id);
    expect(messages[0]?.body).toBe('hello');
    expect(messages[0]?.state).toBe('delivered');
    expect(messages[0]?.readAt).toBeNull();
  });

  // ── AC-1 step 6: markRead transitions the message to 'read' ──
  it('14e. workerB markRead transitions the message to read (state + readAt)', async () => {
    const sent = await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'hello',
    });
    const result = await world.reader.markRead({
      callerContext: world.ctxB,
      messageIds: [sent.messageId],
    });
    expect(result.marked).toEqual([sent.messageId]);
    expect(result.ignored).toEqual([]);

    const after = await world.reader.readMailbox({ callerContext: world.ctxB });
    expect(after).toHaveLength(1);
    expect(after[0]?.state).toBe('read');
    expect(after[0]?.readAt).toBeInstanceOf(Date);
  });

  // ── AC-5: summarizeUnreadForCell — workerA msg is read, workerC sends two ──
  it('14f. summarizeUnreadForCell — counts only delivered, groups by sender', async () => {
    // workerA's message → mark read so it doesn't count.
    const aMsg = await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'hi-from-A',
    });
    await world.reader.markRead({
      callerContext: world.ctxB,
      messageIds: [aMsg.messageId],
    });

    // workerC sends one — summary should show 1 unread, sender = workerC.
    await world.sender.sendMessage({
      callerContext: world.ctxC,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'one',
    });
    const cellB = await world.cellsRepo.findCellByOwner(world.workerB.id);
    expect(cellB).not.toBeNull();

    const summaryAfterOne = await world.cellsRepo.summarizeUnreadForCell(cellB!.id);
    expect(summaryAfterOne.unreadCount).toBe(1);
    expect(summaryAfterOne.distinctSenderIds).toEqual([world.workerC.id]);

    // workerC sends a second — summary should now show 2 unread, still one sender.
    await world.sender.sendMessage({
      callerContext: world.ctxC,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'two',
    });
    const summaryAfterTwo = await world.cellsRepo.summarizeUnreadForCell(cellB!.id);
    expect(summaryAfterTwo.unreadCount).toBe(2);
    expect(summaryAfterTwo.distinctSenderIds).toEqual([world.workerC.id]);
  });

  // ── AC-5: findMessageById — own cell returns Message; foreign cell returns null ──
  it('14g. findMessageById — privacy: cross-cell lookup returns null, own-cell returns the Message', async () => {
    const sent = await world.sender.sendMessage({
      callerContext: world.ctxC,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'private',
    });
    const cellB = await world.cellsRepo.findCellByOwner(world.workerB.id);
    const cellA = await world.cellsRepo.findCellByOwner(world.workerA.id);
    expect(cellB).not.toBeNull();
    expect(cellA).not.toBeNull();

    // Own cell → returns the Message.
    const found = await world.cellsRepo.findMessageById(sent.messageId, cellB!.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(sent.messageId);
    expect(found?.body).toBe('private');
    expect(found?.fromParticipantId).toBe(world.workerC.id);
    expect(found?.toParticipantId).toBe(world.workerB.id);

    // Foreign cell (workerA's) → returns null indistinguishable from "not found".
    const crossCell = await world.cellsRepo.findMessageById(sent.messageId, cellA!.id);
    expect(crossCell).toBeNull();
  });
});
