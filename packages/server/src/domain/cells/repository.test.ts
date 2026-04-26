import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { Kysely } from 'kysely';

import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { createCellsRepo, mapKindToOwnerKind } from './repository.js';
import type { Message } from './types.js';

interface CellsWorld {
  db: Kysely<Database>;
  hiveId: string;
  colonyId: string;
  hivekeeperA: string;
  hivekeeperB: string;
  agentA: string;
  agentB: string;
}

async function seedCellsWorld(): Promise<CellsWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const hivekeeperA = uuidv7();
  const hivekeeperB = uuidv7();
  const agentA = uuidv7();
  const agentB = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'Cells Test Hive' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();

  for (const [id, email] of [
    [hivekeeperA, 'a@example.com'],
    [hivekeeperB, 'b@example.com'],
  ] as const) {
    await db
      .insertInto('hivekeepers')
      .values({
        id,
        hive_id: hiveId,
        colony_id: colonyId,
        email,
        display_name: null,
        is_admin: 1,
        state: 'active',
        revoked_at: null,
      })
      .execute();
  }

  for (const [id, name] of [
    [agentA, 'agent-a'],
    [agentB, 'agent-b'],
  ] as const) {
    await db
      .insertInto('agents')
      .values({
        id,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: hivekeeperA,
        name,
        type: 'worker',
        capabilities: '[]',
        instructions: '',
        state: 'active',
        revoked_at: null,
      })
      .execute();
  }

  return { db, hiveId, colonyId, hivekeeperA, hivekeeperB, agentA, agentB };
}

describe('cells repository', () => {
  let world: CellsWorld;

  beforeEach(async () => {
    world = await seedCellsWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  describe('mapKindToOwnerKind', () => {
    it('keeps hivekeeper as hivekeeper', () => {
      expect(mapKindToOwnerKind('hivekeeper')).toBe('hivekeeper');
    });

    it('collapses worker and scout into agent', () => {
      expect(mapKindToOwnerKind('worker')).toBe('agent');
      expect(mapKindToOwnerKind('scout')).toBe('agent');
    });
  });

  describe('createCell', () => {
    it('inserts an active Cell and returns the entity', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.hivekeeperA,
        ownerKind: 'hivekeeper',
        hiveId: world.hiveId,
      });
      expect(cell.ownerId).toBe(world.hivekeeperA);
      expect(cell.ownerKind).toBe('hivekeeper');
      expect(cell.hiveId).toBe(world.hiveId);
      expect(cell.state).toBe('active');
      expect(cell.closedAt).toBeNull();
      expect(cell.createdAt).toBeInstanceOf(Date);
    });

    it('rejects a second Cell for the same owner (UNIQUE owner_id)', async () => {
      const repo = createCellsRepo(world.db);
      await repo.createCell({
        ownerId: world.hivekeeperA,
        ownerKind: 'hivekeeper',
        hiveId: world.hiveId,
      });
      await expect(
        repo.createCell({
          ownerId: world.hivekeeperA,
          ownerKind: 'hivekeeper',
          hiveId: world.hiveId,
        }),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });

  describe('findCellByOwner / findCellById / getCellState', () => {
    it('finds a cell by owner_id', async () => {
      const repo = createCellsRepo(world.db);
      const created = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const found = await repo.findCellByOwner(world.agentA);
      expect(found?.id).toBe(created.id);
      expect(found?.ownerKind).toBe('agent');
    });

    it('returns null when no cell exists for the owner', async () => {
      const repo = createCellsRepo(world.db);
      expect(await repo.findCellByOwner(uuidv7())).toBeNull();
    });

    it('finds a cell by id', async () => {
      const repo = createCellsRepo(world.db);
      const created = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const found = await repo.findCellById(created.id);
      expect(found?.ownerId).toBe(world.agentA);
    });

    it('getCellState returns the minimal projection', async () => {
      const repo = createCellsRepo(world.db);
      const created = await repo.createCell({
        ownerId: world.agentB,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const summary = await repo.getCellState(created.id);
      expect(summary).toEqual({
        state: 'active',
        ownerId: world.agentB,
        ownerKind: 'agent',
      });
    });

    it('getCellState returns null for unknown cell', async () => {
      const repo = createCellsRepo(world.db);
      expect(await repo.getCellState(uuidv7())).toBeNull();
    });
  });

  describe('closeCell', () => {
    it('closes by cellId and returns the transitioned id', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const result = await repo.closeCell({ cellId: cell.id });
      expect(result.closedCellIds).toEqual([cell.id]);

      const after = await repo.findCellById(cell.id);
      expect(after?.state).toBe('closed');
      expect(after?.closedAt).toBeInstanceOf(Date);
    });

    it('closes by ownerId', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.hivekeeperA,
        ownerKind: 'hivekeeper',
        hiveId: world.hiveId,
      });
      const result = await repo.closeCell({ ownerId: world.hivekeeperA });
      expect(result.closedCellIds).toEqual([cell.id]);
    });

    it('is idempotent on an already-closed cell (returns [])', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      await repo.closeCell({ cellId: cell.id });
      const second = await repo.closeCell({ cellId: cell.id });
      expect(second.closedCellIds).toEqual([]);
    });

    it('returns [] when the cellId is unknown', async () => {
      const repo = createCellsRepo(world.db);
      const result = await repo.closeCell({ cellId: uuidv7() });
      expect(result.closedCellIds).toEqual([]);
    });

    it('throws when neither cellId nor ownerId is provided', async () => {
      const repo = createCellsRepo(world.db);
      await expect(repo.closeCell({})).rejects.toThrow(/at least one of/);
    });
  });

  describe('closeCellsByOwner', () => {
    it('closes only active cells matching the owners', async () => {
      const repo = createCellsRepo(world.db);
      const cellA = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const cellB = await repo.createCell({
        ownerId: world.agentB,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const result = await repo.closeCellsByOwner([world.agentA, world.agentB]);
      expect(new Set(result.closedCellIds)).toEqual(new Set([cellA.id, cellB.id]));
    });

    it('returns [] when the owner list is empty', async () => {
      const repo = createCellsRepo(world.db);
      const result = await repo.closeCellsByOwner([]);
      expect(result.closedCellIds).toEqual([]);
    });

    it('does not re-close already-closed cells', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      await repo.closeCell({ cellId: cell.id });
      const result = await repo.closeCellsByOwner([world.agentA]);
      expect(result.closedCellIds).toEqual([]);
    });
  });

  describe('insertMessage / listMessages / markMessageRead', () => {
    async function setupCellWithMessages(repo = createCellsRepo(world.db)) {
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      // Insert 3 messages with monotonically increasing delivered_at to make ordering deterministic.
      const baseTime = new Date('2026-04-26T10:00:00.000Z').getTime();
      const messages: Message[] = [];
      for (let i = 0; i < 3; i++) {
        const m: Message = {
          id: uuidv7(),
          cellId: cell.id,
          fromParticipantId: world.hivekeeperB,
          toParticipantId: world.agentA,
          type: i === 0 ? 'request' : i === 1 ? 'response' : 'notification',
          body: `body-${i}`,
          action: i === 0 ? { kind: 'demo' } : null,
          replyTo: null,
          ttl: null,
          sentAt: new Date(baseTime + i * 1000),
          deliveredAt: new Date(baseTime + i * 1000),
          readAt: null,
          state: 'delivered',
          expiredAt: null,
        };
        await repo.insertMessage(m);
        messages.push(m);
      }
      return { cell, messages };
    }

    it('insertMessage persists all fields and listMessages returns them newest-first', async () => {
      const repo = createCellsRepo(world.db);
      const { cell, messages } = await setupCellWithMessages(repo);

      const result = await repo.listMessages(cell.id, {}, { cursor: null, limit: 10 });
      expect(result.length).toBe(3);
      // Newest first.
      expect(result[0]?.id).toBe(messages[2]?.id);
      expect(result[2]?.id).toBe(messages[0]?.id);
      // Action JSON parsed back.
      const reqMsg = result.find((m) => m.id === messages[0]?.id);
      expect(reqMsg?.action).toEqual({ kind: 'demo' });
      // Other shapes intact.
      expect(reqMsg?.from).toBe(world.hivekeeperB);
      expect(reqMsg?.to).toBe(world.agentA);
      expect(reqMsg?.body).toBe('body-0');
      expect(reqMsg?.state).toBe('delivered');
      expect(reqMsg?.readAt).toBeNull();
      expect(reqMsg?.deliveredAt).toBeInstanceOf(Date);
    });

    it('listMessages applies the unreadOnly filter (state=delivered)', async () => {
      const repo = createCellsRepo(world.db);
      const { cell, messages } = await setupCellWithMessages(repo);
      // Mark the middle one as read.
      const result = await repo.markMessageRead(
        messages[1]!.id,
        cell.id,
        new Date('2026-04-26T11:00:00.000Z'),
      );
      expect(result.affected).toBe(1);

      const unread = await repo.listMessages(
        cell.id,
        { unreadOnly: true },
        { cursor: null, limit: 10 },
      );
      expect(unread.length).toBe(2);
      expect(unread.every((m) => m.state === 'delivered')).toBe(true);
    });

    it('listMessages applies the types filter', async () => {
      const repo = createCellsRepo(world.db);
      const { cell } = await setupCellWithMessages(repo);
      const onlyNotifs = await repo.listMessages(
        cell.id,
        { types: ['notification'] },
        { cursor: null, limit: 10 },
      );
      expect(onlyNotifs.length).toBe(1);
      expect(onlyNotifs[0]?.type).toBe('notification');
    });

    it('listMessages paginates deterministically via keyset cursor', async () => {
      const repo = createCellsRepo(world.db);
      const { cell } = await setupCellWithMessages(repo);

      const page1 = await repo.listMessages(cell.id, {}, { cursor: null, limit: 2 });
      expect(page1.length).toBe(2);

      const last = page1[1]!;
      const page2 = await repo.listMessages(
        cell.id,
        {},
        {
          cursor: { deliveredAt: last.deliveredAt, messageId: last.id },
          limit: 2,
        },
      );
      expect(page2.length).toBe(1);
      // Page 2 is strictly older than the cursor.
      expect(page2[0]?.deliveredAt.getTime()).toBeLessThanOrEqual(last.deliveredAt.getTime());
      // No overlap with page 1.
      expect(page1.find((m) => m.id === page2[0]?.id)).toBeUndefined();
    });

    it('listMessages excludes expired messages by default', async () => {
      const repo = createCellsRepo(world.db);
      const { cell, messages } = await setupCellWithMessages(repo);
      // Manually flip one message to expired.
      await world.db
        .updateTable('messages')
        .set({ state: 'expired', expired_at: new Date().toISOString() })
        .where('id', '=', messages[0]!.id)
        .execute();

      const result = await repo.listMessages(cell.id, {}, { cursor: null, limit: 10 });
      expect(result.length).toBe(2);
      expect(result.find((m) => m.id === messages[0]!.id)).toBeUndefined();
    });

    it('markMessageRead is idempotent (second call returns affected=0)', async () => {
      const repo = createCellsRepo(world.db);
      const { cell, messages } = await setupCellWithMessages(repo);
      const first = await repo.markMessageRead(messages[0]!.id, cell.id, new Date());
      expect(first.affected).toBe(1);
      const second = await repo.markMessageRead(messages[0]!.id, cell.id, new Date());
      expect(second.affected).toBe(0);
    });

    it('markMessageRead requires id+cell match (returns 0 on mismatch)', async () => {
      const repo = createCellsRepo(world.db);
      const { messages } = await setupCellWithMessages(repo);
      const otherCell = await repo.createCell({
        ownerId: world.agentB,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const result = await repo.markMessageRead(messages[0]!.id, otherCell.id, new Date());
      expect(result.affected).toBe(0);
    });
  });

  describe('summarizeUnreadForCell', () => {
    it('returns { 0, [] } for an empty cell with no messages', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const result = await repo.summarizeUnreadForCell(cell.id);
      expect(result).toEqual({ unreadCount: 0, distinctSenderIds: [] });
    });

    it('counts all delivered messages and orders distinct senders by MAX(delivered_at) DESC, sender ASC', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      // Three senders. Make MAX(delivered_at) deterministic per sender so we can assert ordering:
      //   senderA: 3 messages, latest at t=4000  → MAX = 4000
      //   senderB: 2 messages, latest at t=5000  → MAX = 5000  (newest, first)
      //   senderC: 1 message,  latest at t=3000  → MAX = 3000  (oldest, last)
      // Expected ordering: [senderB, senderA, senderC].
      const senderA = uuidv7();
      const senderB = uuidv7();
      const senderC = uuidv7();
      const baseTime = new Date('2026-04-26T10:00:00.000Z').getTime();

      const seed: Array<{ sender: string; tOffset: number }> = [
        { sender: senderA, tOffset: 1000 },
        { sender: senderA, tOffset: 2000 },
        { sender: senderA, tOffset: 4000 },
        { sender: senderB, tOffset: 1500 },
        { sender: senderB, tOffset: 5000 },
        { sender: senderC, tOffset: 3000 },
      ];
      for (const s of seed) {
        const m: Message = {
          id: uuidv7(),
          cellId: cell.id,
          fromParticipantId: s.sender,
          toParticipantId: world.agentA,
          type: 'notification',
          body: `from ${s.sender} @ ${s.tOffset}`,
          action: null,
          replyTo: null,
          ttl: null,
          sentAt: new Date(baseTime + s.tOffset),
          deliveredAt: new Date(baseTime + s.tOffset),
          readAt: null,
          state: 'delivered',
          expiredAt: null,
        };
        await repo.insertMessage(m);
      }

      const result = await repo.summarizeUnreadForCell(cell.id);
      expect(result.unreadCount).toBe(6);
      expect(result.distinctSenderIds).toEqual([senderB, senderA, senderC]);
    });

    it('counts only messages with state=delivered (excludes read and expired)', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const senderD = uuidv7(); // delivered (×2)
      const senderR = uuidv7(); // read     (×2)
      const senderE = uuidv7(); // expired  (×1)
      const baseTime = new Date('2026-04-26T10:00:00.000Z').getTime();
      let i = 0;
      const seedOne = async (sender: string, state: Message['state']): Promise<string> => {
        const id = uuidv7();
        const m: Message = {
          id,
          cellId: cell.id,
          fromParticipantId: sender,
          toParticipantId: world.agentA,
          type: 'notification',
          body: `i=${i}`,
          action: null,
          replyTo: null,
          ttl: null,
          sentAt: new Date(baseTime + i * 1000),
          deliveredAt: new Date(baseTime + i * 1000),
          readAt: state === 'read' ? new Date(baseTime + i * 1000 + 100) : null,
          state,
          expiredAt: state === 'expired' ? new Date(baseTime + i * 1000 + 200) : null,
        };
        i++;
        await repo.insertMessage(m);
        return id;
      };
      await seedOne(senderD, 'delivered');
      await seedOne(senderD, 'delivered');
      await seedOne(senderR, 'read');
      await seedOne(senderR, 'read');
      await seedOne(senderE, 'expired');

      const result = await repo.summarizeUnreadForCell(cell.id);
      expect(result.unreadCount).toBe(2);
      expect(result.distinctSenderIds).toEqual([senderD]);
    });

    it('returns { 0, [] } silently when the cell is closed and has no delivered messages', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      await repo.closeCell({ cellId: cell.id });
      const result = await repo.summarizeUnreadForCell(cell.id);
      expect(result).toEqual({ unreadCount: 0, distinctSenderIds: [] });
    });

    it('reports delivered messages even if the cell was later closed (query is not gated by cell state)', async () => {
      // Edge case: per tech spec line 139, no normal caller invokes summarizeUnreadForCell
      // on a closed Cell (Waggle suppresses push beforehand). The query is not cell-state-gated;
      // it simply reports what the index sees. This test pins that behavior.
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const sender = uuidv7();
      const m: Message = {
        id: uuidv7(),
        cellId: cell.id,
        fromParticipantId: sender,
        toParticipantId: world.agentA,
        type: 'notification',
        body: 'lingering',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: new Date('2026-04-26T10:00:00.000Z'),
        deliveredAt: new Date('2026-04-26T10:00:00.000Z'),
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      };
      await repo.insertMessage(m);
      await repo.closeCell({ cellId: cell.id });

      const result = await repo.summarizeUnreadForCell(cell.id);
      expect(result.unreadCount).toBe(1);
      expect(result.distinctSenderIds).toEqual([sender]);
    });
  });

  describe('findMessageById', () => {
    it('returns the Message when it belongs to the queried cell', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const m: Message = {
        id: uuidv7(),
        cellId: cell.id,
        fromParticipantId: world.hivekeeperA,
        toParticipantId: world.agentA,
        type: 'request',
        body: 'hello',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: new Date('2026-04-26T10:00:00.000Z'),
        deliveredAt: new Date('2026-04-26T10:00:01.000Z'),
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      };
      await repo.insertMessage(m);

      const found = await repo.findMessageById(m.id, cell.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(m.id);
      expect(found?.cellId).toBe(cell.id);
      expect(found?.fromParticipantId).toBe(world.hivekeeperA);
      expect(found?.toParticipantId).toBe(world.agentA);
      expect(found?.type).toBe('request');
      expect(found?.body).toBe('hello');
      expect(found?.state).toBe('delivered');
      expect(found?.expiredAt).toBeNull();
    });

    it('returns null when the message belongs to a different cell (privacy: indistinguishable from not-found)', async () => {
      const repo = createCellsRepo(world.db);
      const cellX = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const cellY = await repo.createCell({
        ownerId: world.agentB,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const m: Message = {
        id: uuidv7(),
        cellId: cellX.id,
        fromParticipantId: world.hivekeeperA,
        toParticipantId: world.agentA,
        type: 'notification',
        body: 'cellX-only',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: new Date(),
        deliveredAt: new Date(),
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      };
      await repo.insertMessage(m);

      const found = await repo.findMessageById(m.id, cellY.id);
      expect(found).toBeNull();
    });

    it('returns null when the messageId is unknown', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const found = await repo.findMessageById(uuidv7(), cell.id);
      expect(found).toBeNull();
    });

    it('returns null for messages in state=expired (defense in depth)', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const m: Message = {
        id: uuidv7(),
        cellId: cell.id,
        fromParticipantId: world.hivekeeperA,
        toParticipantId: world.agentA,
        type: 'notification',
        body: 'soon-expired',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: new Date(),
        deliveredAt: new Date(),
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      };
      await repo.insertMessage(m);
      // Force-flip to expired via direct UPDATE (the expiration job is deferred in B0).
      await world.db
        .updateTable('messages')
        .set({ state: 'expired', expired_at: new Date().toISOString() })
        .where('id', '=', m.id)
        .execute();

      const found = await repo.findMessageById(m.id, cell.id);
      expect(found).toBeNull();
    });

    it('round-trips action JSON, replyTo, ttl (Duration), readAt via rowToMessage', async () => {
      const repo = createCellsRepo(world.db);
      const cell = await repo.createCell({
        ownerId: world.agentA,
        ownerKind: 'agent',
        hiveId: world.hiveId,
      });
      const earlierId = uuidv7();
      const earlier: Message = {
        id: earlierId,
        cellId: cell.id,
        fromParticipantId: world.hivekeeperA,
        toParticipantId: world.agentA,
        type: 'request',
        body: 'parent',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: new Date('2026-04-26T10:00:00.000Z'),
        deliveredAt: new Date('2026-04-26T10:00:00.000Z'),
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      };
      await repo.insertMessage(earlier);

      const replyAt = new Date('2026-04-26T10:00:05.000Z');
      const readAt = new Date('2026-04-26T10:01:00.000Z');
      const reply: Message = {
        id: uuidv7(),
        cellId: cell.id,
        fromParticipantId: world.agentA,
        toParticipantId: world.hivekeeperA,
        type: 'response',
        body: 'pong',
        action: { kind: 'demo', nested: { count: 2 }, list: [1, 2, 3] },
        replyTo: earlierId,
        ttl: 60_000,
        sentAt: replyAt,
        deliveredAt: replyAt,
        readAt,
        state: 'read',
        expiredAt: null,
      };
      await repo.insertMessage(reply);

      const found = await repo.findMessageById(reply.id, cell.id);
      expect(found).not.toBeNull();
      expect(found?.action).toEqual({ kind: 'demo', nested: { count: 2 }, list: [1, 2, 3] });
      expect(found?.replyTo).toBe(earlierId);
      expect(found?.ttl).toBe(60_000);
      expect(found?.readAt).toBeInstanceOf(Date);
      expect(found?.readAt?.toISOString()).toBe(readAt.toISOString());
      expect(found?.deliveredAt.toISOString()).toBe(replyAt.toISOString());
      expect(found?.sentAt.toISOString()).toBe(replyAt.toISOString());
      expect(found?.state).toBe('read');
      expect(found?.expiredAt).toBeNull();
    });
  });

  describe('optional-tx pattern', () => {
    it('participates in an outer transaction (rollback)', async () => {
      const repo = createCellsRepo(world.db);
      try {
        await world.db.transaction().execute(async (tx) => {
          await repo.createCell(
            { ownerId: world.agentA, ownerKind: 'agent', hiveId: world.hiveId },
            tx,
          );
          throw new Error('boom — rollback');
        });
      } catch (err) {
        expect((err as Error).message).toMatch(/boom/);
      }
      // Verify the cell was rolled back.
      const found = await repo.findCellByOwner(world.agentA);
      expect(found).toBeNull();
    });
  });
});
