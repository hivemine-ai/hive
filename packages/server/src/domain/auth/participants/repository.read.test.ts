import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '#observability/logger.js';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { CallerContext } from '../caller-context.js';
import { createParticipantsReadRepo } from './repository.js';
import { createParticipantsWriteRepo } from './repository.write.js';

const SYSTEM_CALLER: CallerContext = { kind: 'system', osUser: 'tests' };

describe('participants read repository', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('findHiveById returns the hive when it exists', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const hive = await repo.findHiveById(world.hiveId);
    expect(hive?.id).toBe(world.hiveId);
    expect(hive?.name).toBe('Test Hive');
    expect(hive?.createdAt).toBeInstanceOf(Date);
  });

  it('findHiveById returns null when the hive does not exist', async () => {
    const repo = createParticipantsReadRepo(world.db);
    expect(await repo.findHiveById('019dffff-0000-0000-0000-000000000000')).toBeNull();
  });

  it('findHivekeeperById hydrates is_admin from INTEGER 0/1 to boolean', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const admin = await repo.findHivekeeperById(world.adminHivekeeperId);
    const keeper = await repo.findHivekeeperById(world.nonAdminHivekeeperId);
    expect(admin?.isAdmin).toBe(true);
    expect(keeper?.isAdmin).toBe(false);
  });

  it('findHivekeeperByEmail is case-insensitive', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const upper = await repo.findHivekeeperByEmail(world.hiveId, 'ADMIN@EXAMPLE.COM');
    expect(upper?.id).toBe(world.adminHivekeeperId);
    const mixed = await repo.findHivekeeperByEmail(world.hiveId, 'AdMiN@Example.com');
    expect(mixed?.id).toBe(world.adminHivekeeperId);
  });

  it('findHivekeeperByEmailLocalPart matches the local-part of an email case-insensitively', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const exact = await repo.findHivekeeperByEmailLocalPart(world.hiveId, 'admin');
    expect(exact?.id).toBe(world.adminHivekeeperId);
    const upper = await repo.findHivekeeperByEmailLocalPart(world.hiveId, 'ADMIN');
    expect(upper?.id).toBe(world.adminHivekeeperId);
  });

  it('findHivekeeperByEmailLocalPart matches a local-part with embedded dots', async () => {
    const repo = createParticipantsReadRepo(world.db);
    // Insert a hivekeeper with a dotted local-part so the lookup truly exercises
    // the substring extraction (admin@example.com would match a naive "starts-with" too).
    await world.db
      .insertInto('hivekeepers')
      .values({
        id: '019dffff-0000-0000-0000-0000000000aa',
        hive_id: world.hiveId,
        colony_id: world.colonyId,
        email: 'John.Doe@another-domain.com',
        display_name: null,
        is_admin: 0,
        state: 'active',
        revoked_at: null,
      })
      .execute();
    const found = await repo.findHivekeeperByEmailLocalPart(world.hiveId, 'john.doe');
    expect(found?.email).toBe('John.Doe@another-domain.com');
  });

  it('findHivekeeperByEmailLocalPart returns null when no match', async () => {
    const repo = createParticipantsReadRepo(world.db);
    expect(await repo.findHivekeeperByEmailLocalPart(world.hiveId, 'no-such-keeper')).toBeNull();
  });

  it('findHivekeeperByEmailLocalPart does not match when the same local-part lives in a different hive', async () => {
    const repo = createParticipantsReadRepo(world.db);
    // The default seed has admin@example.com in world.hiveId; query against a fake hive id.
    expect(
      await repo.findHivekeeperByEmailLocalPart('019dffff-0000-0000-0000-0000000000ff', 'admin'),
    ).toBeNull();
  });

  it('findAgentById parses capabilities JSON into a string array', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const worker = await repo.findAgentById(world.workerAgentId);
    expect(worker?.capabilities).toEqual(world.workerCapabilities);
    const scout = await repo.findAgentById(world.scoutAgentId);
    expect(scout?.capabilities).toEqual([]);
  });

  it('findAgentByName returns the agent for an active row', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const worker = await repo.findAgentByName(world.hiveId, world.adminHivekeeperId, 'worker-1');
    expect(worker?.id).toBe(world.workerAgentId);
  });

  it('findById is polymorphic — returns Hivekeeper variant', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const result = await repo.findById(world.adminHivekeeperId);
    expect(result?.kind).toBe('hivekeeper');
    if (result?.kind === 'hivekeeper') {
      expect(result.hivekeeper.id).toBe(world.adminHivekeeperId);
    }
  });

  it('findById is polymorphic — returns Agent variant', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const result = await repo.findById(world.workerAgentId);
    expect(result?.kind).toBe('agent');
    if (result?.kind === 'agent') {
      expect(result.agent.id).toBe(world.workerAgentId);
      expect(result.agent.type).toBe('worker');
    }
  });

  it('findById returns null when id matches no participant', async () => {
    const repo = createParticipantsReadRepo(world.db);
    expect(await repo.findById('019dffff-0000-0000-0000-000000000000')).toBeNull();
  });

  it('getParticipantState returns minimal projection for hivekeepers', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const summary = await repo.getParticipantState(world.adminHivekeeperId);
    expect(summary?.kind).toBe('hivekeeper');
    expect(summary?.state).toBe('active');
    expect(summary?.isAdmin).toBe(true);
    expect(summary?.ownerId).toBeNull();
  });

  it('getParticipantState returns kind=worker|scout for agents', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const worker = await repo.getParticipantState(world.workerAgentId);
    expect(worker?.kind).toBe('worker');
    const scout = await repo.getParticipantState(world.scoutAgentId);
    expect(scout?.kind).toBe('scout');
    expect(scout?.ownerId).toBe(world.adminHivekeeperId);
    expect(scout?.isAdmin).toBeNull();
  });

  describe('listAgents (keyset pagination)', () => {
    it('returns active agents for the hive ordered by (created_at DESC, id DESC)', async () => {
      const writeRepo = createParticipantsWriteRepo(world.db);
      const readRepo = createParticipantsReadRepo(world.db);
      // Create extra agents to ensure ordering works.
      for (let i = 0; i < 5; i++) {
        await writeRepo.createAgent(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            ownerId: world.adminHivekeeperId,
            name: `pg-worker-${i}`,
            type: 'worker',
          },
          SYSTEM_CALLER,
        );
      }
      const result = await readRepo.listAgents({
        hiveId: world.hiveId,
        state: 'active',
        pagination: { cursor: null, limit: 100 },
      });
      // Seeded 2 (worker-1, scout-1) + 5 new = 7.
      expect(result.agents.length).toBe(7);
      // Most recently created first.
      const createdMillis = result.agents.map((a) => a.createdAt.getTime());
      const sortedDesc = [...createdMillis].sort((a, b) => b - a);
      expect(createdMillis).toEqual(sortedDesc);
      expect(result.nextCursor).toBeNull();
    });

    it('paginates deterministically across multiple pages with >limit rows', async () => {
      const writeRepo = createParticipantsWriteRepo(world.db);
      const readRepo = createParticipantsReadRepo(world.db);
      // Create enough agents to need 3 pages.
      for (let i = 0; i < 20; i++) {
        await writeRepo.createAgent(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            ownerId: world.adminHivekeeperId,
            name: `pgw-${i}`,
            type: 'worker',
          },
          SYSTEM_CALLER,
        );
      }
      const seenIds = new Set<string>();
      let cursor: { createdAt: Date; id: string } | null = null;
      let pages = 0;
      do {
        const page = await readRepo.listAgents({
          hiveId: world.hiveId,
          pagination: { cursor, limit: 5 },
        });
        for (const a of page.agents) {
          expect(seenIds.has(a.id)).toBe(false); // no duplicates across pages
          seenIds.add(a.id);
        }
        cursor = page.nextCursor;
        pages++;
        if (pages > 10) throw new Error('too many pages — bug?');
      } while (cursor !== null);
      // Seeded 2 + 20 new = 22 total agents → 5 pages of 5 + 1 of 2.
      expect(seenIds.size).toBe(22);
    });

    it('caps the page size to the server-side max', async () => {
      const readRepo = createParticipantsReadRepo(world.db, 'sqlite', {
        listMaxPageSize: 3,
      });
      const result = await readRepo.listAgents({
        hiveId: world.hiveId,
        pagination: { cursor: null, limit: 100 },
      });
      // Max 3 returned; seeded 2 active agents → both fit (<3).
      expect(result.agents.length).toBeLessThanOrEqual(3);
    });
  });

  describe('listAgents capability filter (PRY-029)', () => {
    it('matches agents whose capabilities array contains the substring', async () => {
      const writeRepo = createParticipantsWriteRepo(world.db);
      const readRepo = createParticipantsReadRepo(world.db);
      // Create three agents with distinct capability sets.
      await writeRepo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.adminHivekeeperId,
          name: 'summarizer',
          type: 'worker',
          capabilities: ['summarize', 'translate'],
        },
        SYSTEM_CALLER,
      );
      await writeRepo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.adminHivekeeperId,
          name: 'classifier',
          type: 'worker',
          capabilities: ['classify', 'extract'],
        },
        SYSTEM_CALLER,
      );
      await writeRepo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.adminHivekeeperId,
          name: 'multi',
          type: 'worker',
          capabilities: ['summarize', 'classify', 'extract'],
        },
        SYSTEM_CALLER,
      );

      const summarizers = await readRepo.listAgents({
        hiveId: world.hiveId,
        capability: 'summarize',
        pagination: { cursor: null, limit: 50 },
      });
      const names = summarizers.agents.map((a) => a.name).sort();
      expect(names).toEqual(['multi', 'summarizer']);
    });

    it('returns empty result when no agent has the capability', async () => {
      const readRepo = createParticipantsReadRepo(world.db);
      const result = await readRepo.listAgents({
        hiveId: world.hiveId,
        capability: 'no-such-capability-xyz',
        pagination: { cursor: null, limit: 50 },
      });
      expect(result.agents).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('combines capability filter with type and owner filters', async () => {
      const writeRepo = createParticipantsWriteRepo(world.db);
      const readRepo = createParticipantsReadRepo(world.db);
      await writeRepo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.adminHivekeeperId,
          name: 'admin-summarizer',
          type: 'worker',
          capabilities: ['summarize'],
        },
        SYSTEM_CALLER,
      );
      await writeRepo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.nonAdminHivekeeperId,
          name: 'other-summarizer',
          type: 'worker',
          capabilities: ['summarize'],
        },
        SYSTEM_CALLER,
      );

      const result = await readRepo.listAgents({
        hiveId: world.hiveId,
        type: 'worker',
        ownerId: world.adminHivekeeperId,
        capability: 'summarize',
        pagination: { cursor: null, limit: 50 },
      });
      const names = result.agents.map((a) => a.name);
      expect(names).toContain('admin-summarizer');
      expect(names).not.toContain('other-summarizer');
    });
  });

  // PRY-030 — `last_connected_at` persistence side-effect of `presenceRegistry.subscribe`.
  describe('updateAgentLastConnectedAt', () => {
    it('stamps last_connected_at on the agent row and rowToAgent reflects it', async () => {
      const repo = createParticipantsReadRepo(world.db);
      const before = await repo.findAgentById(world.workerAgentId);
      expect(before?.lastConnectedAt).toBeNull();

      const ts = new Date('2026-05-01T12:00:00.000Z');
      await repo.updateAgentLastConnectedAt(world.workerAgentId, ts);

      const after = await repo.findAgentById(world.workerAgentId);
      expect(after?.lastConnectedAt?.toISOString()).toBe(ts.toISOString());
    });

    it('is idempotent — repeated calls overwrite with the latest timestamp', async () => {
      const repo = createParticipantsReadRepo(world.db);
      const t1 = new Date('2026-05-01T12:00:00.000Z');
      const t2 = new Date('2026-05-01T12:30:00.000Z');
      await repo.updateAgentLastConnectedAt(world.workerAgentId, t1);
      await repo.updateAgentLastConnectedAt(world.workerAgentId, t2);
      const after = await repo.findAgentById(world.workerAgentId);
      expect(after?.lastConnectedAt?.toISOString()).toBe(t2.toISOString());
    });

    it('is silent no-op + warn when the agent does not exist', async () => {
      const warn = vi.fn();
      const logger = { warn } as unknown as Logger;
      const repo = createParticipantsReadRepo(world.db, 'sqlite', { logger });
      const ghost = '019dffff-0000-0000-0000-000000000000';
      await expect(repo.updateAgentLastConnectedAt(ghost, new Date())).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: ghost }),
        expect.stringContaining('updateAgentLastConnectedAt_no_row'),
      );
    });
  });
});
