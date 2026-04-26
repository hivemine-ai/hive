// End-to-end smoke test for PRY-005 (Waggle Pipeline + Presence Registry Slice 0).
//
// Exercises the 9 demoable steps from the tech spec § "Plan de implementación
// — Slice 0" with REAL components:
//   - Real SQLite on disk (per PRY-002 lessons; the tech spec text mentions
//     Postgres but ADR-008 makes SQLite the default and tests follow that).
//   - Real participants write repo with the real cells hook (cell row created
//     atomically with each createAgent / createHivekeeper).
//   - Real Issuer + Verifier (Ed25519) producing real `IdentityContext`s.
//   - Real Sender (PRY-003) firing real `messageDelivered` events.
//   - Real Waggle Pipeline + Presence Registry constructed via the production
//     factory (`createNotificationsForProduction`).
//   - Visibility STUB (`stubVisibilityEngine`) — sufficient: the visibility
//     decision is verified by PRY-004's smoke test.
//   - Mock `SubscriberHandle` capturing notifications in arrays — the real
//     transport binding lands in PRY-006 (API MCP — Tools).
//
// Quiet window is set to 10ms via factory option (per PRY notes — convention
// for integration tests to keep CI fast).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildJwkSet,
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createVerifier,
  generateKeypair,
  loadBlocklist,
  type CallerContext,
  type IdentityContext,
  type ParticipantsWriteRepo,
  type SigningKey,
  type UUIDv7,
} from '#domain/auth/index.js';
import {
  createCellEvents,
  createCellsRepo,
  createSender,
  type CellsRepo,
  type Sender,
} from '#domain/cells/index.js';
import { createCellsHookAdapter } from '#composition/cells-hook-adapter.js';
import { createNotificationsForProduction } from '#composition/notifications-factory.js';
import type { Notifications } from '#composition/notifications-factory.js';
import { stubVisibilityEngine } from '#composition/stubs.js';
import { createDb, type DbConfig } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { createLogger, type Logger } from '#observability/logger.js';

import type { SubscriberHandle } from '../presence/subscriber-handle.js';
import type { WaggleNotification } from './types.js';

const SYSTEM_CALLER: CallerContext = {
  kind: 'system',
  osUser: 'pry-005-smoke',
  operatorNote: 'pry-005 hito-10 e2e smoke',
};

const QUIET_WINDOW_MS = 10;
// Buffer above QUIET_WINDOW_MS to give the timer + flush + delivery a margin.
const FLUSH_GRACE_MS = 200;

interface MockHandle extends SubscriberHandle {
  captured: WaggleNotification[];
  triggerClose: () => void;
}

function mockHandle(callerContext: IdentityContext): MockHandle {
  const captured: WaggleNotification[] = [];
  let onCloseCb: (() => void) | null = null;
  return {
    connectionId: uuidv7(),
    callerContext,
    captured,
    deliver(notification: WaggleNotification) {
      captured.push(notification);
      return Promise.resolve();
    },
    onClose(cb: () => void) {
      onCloseCb = cb;
    },
    triggerClose() {
      onCloseCb?.();
    },
  };
}

interface SmokeWorld {
  cleanup: () => Promise<void>;
  cellsRepo: CellsRepo;
  sender: Sender;
  notifications: Notifications;
  hiveId: UUIDv7;
  workerA: { id: UUIDv7 };
  workerB: { id: UUIDv7 };
  ctxA: IdentityContext;
  ctxB: IdentityContext;
  logger: Logger;
}

async function seedSmokeWorld(): Promise<SmokeWorld> {
  // ── filesystem & db (real SQLite on disk) ──
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pry005-smoke-'));
  const dbPath = path.join(workDir, 'hive.sqlite');
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

  // ── hive + colony ──
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

  // ── repos wired with real cells hook (atomicity) ──
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

  // ── credentials + verifier (real JWTs and IdentityContexts) ──
  const issuer = createIssuer({
    signingKey,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
    defaultTtlMs: 60_000,
    db,
  });
  const credA = await issuer.issueCredential({ participantId: workerA.id });
  const credB = await issuer.issueCredential({ participantId: workerB.id });

  const blocklist = await loadBlocklist(db);
  const signingKeys = new Map<string, SigningKey>([[signingKey.kid, signingKey]]);
  buildJwkSet(signingKeys.values());
  const verifier = createVerifier({
    signingKeys,
    blocklist,
    participantsRepo: readRepo,
    hiveStableIdentifier: hiveId,
  });
  const ctxA = await verifier.verify(`Bearer ${credA.jwt}`);
  const ctxB = await verifier.verify(`Bearer ${credB.jwt}`);

  // ── cell events + sender (real fan-out from sendMessage) ──
  const events = createCellEvents();
  const sender = createSender({
    cellsRepo,
    visibilityEngine: stubVisibilityEngine,
    events,
    db,
  });

  // ── logger (silenced via 'silent' level so test output stays clean) ──
  const logger = createLogger({ level: 'silent' });

  // ── notifications subsystem (real Pipeline + Presence Registry) ──
  const notifications = createNotificationsForProduction(
    {
      cellEvents: events,
      cellsRepo,
      participantsRepo: readRepo,
      logger,
    },
    { quietWindowMs: QUIET_WINDOW_MS },
  );

  return {
    cellsRepo,
    sender,
    notifications,
    hiveId,
    workerA: { id: workerA.id },
    workerB: { id: workerB.id },
    ctxA,
    ctxB,
    logger,
    cleanup: async () => {
      await db.destroy();
      await fs.rm(workDir, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('PRY-005 Waggle + Presence Slice 0 — smoke E2E', () => {
  let world: SmokeWorld;

  beforeEach(async () => {
    world = await seedSmokeWorld();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  // ── Step 4 — subscribe registers presence ──
  it('subscribe registers presence; getPresence reports online', async () => {
    const handle = mockHandle(world.ctxB);
    const sub = await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle,
    });

    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.notifications.presenceRegistry.getPresence(world.workerB.id).online).toBe(true);
  });

  // ── Steps 5-7 — online path: send → wait window → mock receives Waggle ──
  it('online path: workerA sends to workerB → mockHandleB receives kind=online with right payload', async () => {
    const handle = mockHandle(world.ctxB);
    await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle,
    });
    // Drain the post-subscribe replay (Cell is empty; the replay path returns
    // null from the builder so nothing is delivered).
    await sleep(FLUSH_GRACE_MS);

    const sent = await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'hello from a',
    });
    expect(sent.replayed).toBe(false);

    await sleep(QUIET_WINDOW_MS + FLUSH_GRACE_MS);

    const onlineWaggles = handle.captured.filter((w) => w.kind === 'online');
    expect(onlineWaggles.length).toBeGreaterThanOrEqual(1);
    const w = onlineWaggles[0]!;
    expect(w.recipientId).toBe(world.workerB.id);
    expect(w.unreadCount).toBeGreaterThanOrEqual(1);
    expect(w.senderIds).toContain(world.workerA.id);
  });

  // ── Step 8 — close subscription → presence offline ──
  it('subscription.close() flips presence to offline', async () => {
    const handle = mockHandle(world.ctxB);
    const sub = await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle,
    });

    sub.close();

    expect(world.notifications.presenceRegistry.getPresence(world.workerB.id).online).toBe(false);
  });

  // ── Step 9 — replay: re-subscribe with fresh handle → receives kind=replay ──
  it('replay path: send while offline, then re-subscribe → fresh handle receives kind=replay with unreadCount>=1', async () => {
    // Send a message BEFORE workerB ever subscribed — message persists, no
    // online push fires (no presence).
    await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'queued for replay',
    });
    await sleep(FLUSH_GRACE_MS);

    // Now subscribe — replay should fire.
    const handle = mockHandle(world.ctxB);
    await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle,
    });
    await sleep(FLUSH_GRACE_MS);

    const replayWaggles = handle.captured.filter((w) => w.kind === 'replay');
    expect(replayWaggles.length).toBeGreaterThanOrEqual(1);
    const w = replayWaggles[0]!;
    expect(w.recipientId).toBe(world.workerB.id);
    expect(w.unreadCount).toBeGreaterThanOrEqual(1);
    expect(w.senderIds).toContain(world.workerA.id);
  });

  // ── Combined Steps 4-9 — full demo path ──
  it('full Slice 0 demo: subscribe → online → close → re-subscribe → replay', async () => {
    // Step 4
    const handle1 = mockHandle(world.ctxB);
    const sub = await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle: handle1,
    });
    await sleep(FLUSH_GRACE_MS);
    expect(world.notifications.presenceRegistry.getPresence(world.workerB.id).online).toBe(true);

    // Steps 5-7
    await world.sender.sendMessage({
      callerContext: world.ctxA,
      recipientId: world.workerB.id,
      type: 'notification',
      body: 'first',
    });
    await sleep(QUIET_WINDOW_MS + FLUSH_GRACE_MS);
    expect(handle1.captured.some((w) => w.kind === 'online')).toBe(true);

    // Step 8
    sub.close();
    expect(world.notifications.presenceRegistry.getPresence(world.workerB.id).online).toBe(false);

    // Step 9 — re-subscribe (with a fresh handle)
    const handle2 = mockHandle(world.ctxB);
    await world.notifications.presenceRegistry.subscribe({
      callerContext: world.ctxB,
      handle: handle2,
    });
    await sleep(FLUSH_GRACE_MS);

    const replays = handle2.captured.filter((w) => w.kind === 'replay');
    expect(replays.length).toBeGreaterThanOrEqual(1);
    expect(replays[0]?.unreadCount).toBeGreaterThanOrEqual(1);
  });

  // Note: the `suspended` and `revoked` suppression paths are covered by
  // pipeline.test.ts unit tests (the rig fakes the participant-state without
  // requiring an admin op). Adding them at smoke level would require pulling
  // the writeRepo into the world AND exposing a revokeAgent path that this
  // PRY does not consume — out of Slice 0 scope.
});
