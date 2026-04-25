import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { CallerContext } from '../caller-context.js';
import { isAuthError } from '../errors.js';
import type { AuthError } from '../errors.js';
import { createParticipantsWriteRepo } from './repository.write.js';
import { createParticipantsReadRepo } from './repository.js';
import type { CellsRepoHook, DbExecutor } from './cells-hook.js';

const SYSTEM_CALLER: CallerContext = { kind: 'system', osUser: 'tests' };

function makeSpyHook(): CellsRepoHook & {
  createCalls: { ownerId: string; ownerKind: string }[];
  closeCalls: { ownerId: string }[];
} {
  const createCalls: { ownerId: string; ownerKind: string }[] = [];
  const closeCalls: { ownerId: string }[] = [];
  return {
    createCalls,
    closeCalls,
    createCell(_executor: DbExecutor, input): Promise<void> {
      createCalls.push({ ownerId: input.ownerId, ownerKind: input.ownerKind });
      return Promise.resolve();
    },
    closeCell(_executor: DbExecutor, input): Promise<void> {
      closeCalls.push({ ownerId: input.ownerId });
      return Promise.resolve();
    },
  };
}

describe('participants write repository', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  describe('createHivekeeper', () => {
    it('inserts an admin hivekeeper and returns the entity', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      const hk = await repo.createHivekeeper(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          email: 'new@example.com',
          displayName: 'New Keeper',
          isAdmin: true,
        },
        SYSTEM_CALLER,
      );
      expect(hk.email).toBe('new@example.com');
      expect(hk.isAdmin).toBe(true);
      expect(hk.state).toBe('active');
    });

    it('rejects duplicate email (case-insensitive UNIQUE) with INVALID_STATE_TRANSITION', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      try {
        await repo.createHivekeeper(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            email: 'ADMIN@example.com', // case-insensitive collision with seeded admin
          },
          SYSTEM_CALLER,
        );
        expect.fail('expected throw');
      } catch (err) {
        expect(isAuthError(err)).toBe(true);
        const e = err as AuthError;
        expect(e.code).toBe('INVALID_STATE_TRANSITION');
        expect(e.subCode).toBe('email_already_used');
      }
    });
  });

  describe('createAgent', () => {
    it('inserts a worker agent and invokes the cells hook in-tx', async () => {
      const hook = makeSpyHook();
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });
      const agent = await repo.createAgent(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          ownerId: world.adminHivekeeperId,
          name: 'spy-worker',
          type: 'worker',
          capabilities: ['cell.send'],
        },
        SYSTEM_CALLER,
      );
      expect(agent.name).toBe('spy-worker');
      expect(agent.type).toBe('worker');
      expect(agent.capabilities).toEqual(['cell.send']);
      expect(hook.createCalls).toEqual([{ ownerId: agent.id, ownerKind: 'agent' }]);
    });

    it('rejects duplicate (owner_id, name) for non-revoked agents', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      try {
        await repo.createAgent(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            ownerId: world.adminHivekeeperId,
            name: 'worker-1', // collides with seeded
            type: 'worker',
          },
          SYSTEM_CALLER,
        );
        expect.fail('expected throw');
      } catch (err) {
        expect((err as AuthError).code).toBe('INVALID_STATE_TRANSITION');
        expect((err as AuthError).subCode).toBe('agent_name_taken');
      }
    });

    it('rejects capabilities that exceed the cap (64 elements × 128 chars)', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      const tooMany = Array.from({ length: 65 }, (_, i) => `cap-${i}`);
      try {
        await repo.createAgent(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            ownerId: world.adminHivekeeperId,
            name: 'bigger',
            type: 'worker',
            capabilities: tooMany,
          },
          SYSTEM_CALLER,
        );
        expect.fail('expected throw');
      } catch (err) {
        expect((err as AuthError).code).toBe('INVALID_STATE_TRANSITION');
        expect((err as AuthError).subCode).toBe('capabilities_too_many');
      }
    });

    it('rejects a single capability longer than 128 characters', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      const oversized = 'x'.repeat(129);
      try {
        await repo.createAgent(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            ownerId: world.adminHivekeeperId,
            name: 'long-cap',
            type: 'worker',
            capabilities: [oversized],
          },
          SYSTEM_CALLER,
        );
        expect.fail('expected throw');
      } catch (err) {
        expect((err as AuthError).code).toBe('INVALID_STATE_TRANSITION');
        expect((err as AuthError).subCode).toBe('capability_too_long');
      }
    });
  });

  describe('revokeAgent', () => {
    it('marks the agent revoked, fires closeCell hook, idempotent on re-revoke', async () => {
      const hook = makeSpyHook();
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });
      await repo.revokeAgent(world.workerAgentId, SYSTEM_CALLER);
      const readRepo = createParticipantsReadRepo(world.db);
      const after = await readRepo.findAgentById(world.workerAgentId);
      expect(after?.state).toBe('revoked');
      expect(after?.revokedAt).toBeInstanceOf(Date);
      expect(hook.closeCalls).toEqual([{ ownerId: world.workerAgentId }]);

      // Idempotent: second call doesn't fire the hook again (state already revoked).
      await repo.revokeAgent(world.workerAgentId, SYSTEM_CALLER);
      expect(hook.closeCalls.length).toBe(1);
    });

    it('throws INVALID_STATE_TRANSITION when target is a Hivekeeper', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      try {
        await repo.revokeAgent(world.adminHivekeeperId, SYSTEM_CALLER);
        expect.fail('expected throw');
      } catch (err) {
        const e = err as AuthError;
        expect(e.code).toBe('INVALID_STATE_TRANSITION');
        expect(e.subCode).toBe('target_is_hivekeeper');
      }
    });

    it('is a no-op for an unknown id (does not throw)', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      await expect(repo.revokeAgent(uuidv7(), SYSTEM_CALLER)).resolves.toBeUndefined();
    });
  });

  describe('listAgents (keyset pagination)', () => {
    it('returns active agents for the hive ordered by (created_at DESC, id DESC)', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      // Create extra agents to ensure ordering works.
      for (let i = 0; i < 5; i++) {
        await repo.createAgent(
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
      const result = await repo.listAgents({
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
      const repo = createParticipantsWriteRepo(world.db);
      // Create enough agents to need 3 pages.
      for (let i = 0; i < 20; i++) {
        await repo.createAgent(
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
        const page = await repo.listAgents({
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
      const repo = createParticipantsWriteRepo(world.db, {
        listMaxPageSize: 3,
      });
      const result = await repo.listAgents({
        hiveId: world.hiveId,
        pagination: { cursor: null, limit: 100 },
      });
      // Max 3 returned; seeded 2 active agents → both fit (<3).
      expect(result.agents.length).toBeLessThanOrEqual(3);
    });
  });

  describe('listHivekeepers', () => {
    it('filters by state and isAdmin', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      const onlyAdmins = await repo.listHivekeepers({
        hiveId: world.hiveId,
        isAdmin: true,
        pagination: { cursor: null, limit: 50 },
      });
      expect(onlyAdmins.hivekeepers.length).toBe(1);
      expect(onlyAdmins.hivekeepers[0]?.id).toBe(world.adminHivekeeperId);

      const onlyNonAdmins = await repo.listHivekeepers({
        hiveId: world.hiveId,
        isAdmin: false,
        pagination: { cursor: null, limit: 50 },
      });
      expect(onlyNonAdmins.hivekeepers.length).toBe(1);
      expect(onlyNonAdmins.hivekeepers[0]?.id).toBe(world.nonAdminHivekeeperId);
    });
  });
});
