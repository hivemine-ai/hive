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
  createCalls: { ownerId: string; ownerKind: string; hiveId: string; colonyId: string }[];
  closeCalls: { ownerId: string }[];
  closeByOwnerCalls: { ownerIds: string[] }[];
} {
  const createCalls: {
    ownerId: string;
    ownerKind: string;
    hiveId: string;
    colonyId: string;
  }[] = [];
  const closeCalls: { ownerId: string }[] = [];
  const closeByOwnerCalls: { ownerIds: string[] }[] = [];
  return {
    createCalls,
    closeCalls,
    closeByOwnerCalls,
    createCell(_executor: DbExecutor, input): Promise<void> {
      createCalls.push({
        ownerId: input.ownerId,
        ownerKind: input.ownerKind,
        hiveId: input.hiveId,
        colonyId: input.colonyId,
      });
      return Promise.resolve();
    },
    closeCell(_executor: DbExecutor, input): Promise<void> {
      closeCalls.push({ ownerId: input.ownerId });
      return Promise.resolve();
    },
    closeCellsByOwner(_executor: DbExecutor, input): Promise<void> {
      closeByOwnerCalls.push({ ownerIds: [...input.ownerIds] });
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

    it("calls cellsHook.createCell with ownerKind 'hivekeeper'", async () => {
      const hook = makeSpyHook();
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });
      const hk = await repo.createHivekeeper(
        {
          hiveId: world.hiveId,
          colonyId: world.colonyId,
          email: 'hookspy@example.com',
        },
        SYSTEM_CALLER,
      );
      expect(hook.createCalls).toEqual([
        {
          ownerId: hk.id,
          ownerKind: 'hivekeeper',
          hiveId: world.hiveId,
          colonyId: world.colonyId,
        },
      ]);
      expect(hook.closeCalls).toEqual([]);
    });

    it('rolls back keeper INSERT if cellsHook.createCell throws', async () => {
      const hookError = new Error('cell-store down');
      const failingHook: CellsRepoHook = {
        createCell(): Promise<void> {
          return Promise.reject(hookError);
        },
        closeCell(): Promise<void> {
          return Promise.resolve();
        },
        closeCellsByOwner(): Promise<void> {
          return Promise.resolve();
        },
      };
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: failingHook });

      await expect(
        repo.createHivekeeper(
          {
            hiveId: world.hiveId,
            colonyId: world.colonyId,
            email: 'rollback@example.com',
          },
          SYSTEM_CALLER,
        ),
      ).rejects.toBe(hookError);

      // Atomicity: the hivekeeper INSERT must have been rolled back with the TX.
      const stillThere = await world.db
        .selectFrom('hivekeepers')
        .select('id')
        .where('email', '=', 'rollback@example.com')
        .executeTakeFirst();
      expect(stillThere).toBeUndefined();
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
      expect(hook.createCalls).toEqual([
        {
          ownerId: agent.id,
          ownerKind: 'agent',
          hiveId: world.hiveId,
          colonyId: world.colonyId,
        },
      ]);
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

  describe('revokeHivekeeperWithCascade', () => {
    // Helper: insert active Cells for keeper + agents so the cascade has rows to close.
    // (PRY-003's createParticipantsWriteRepo wires the hook for new participants, but
    // the seedWorld fixture inserts directly without firing the hook — so we seed cells
    // here for the participants we need to test.)
    async function seedCellsFor(
      world: SeedWorld,
      ownerIds: { id: string; kind: 'hivekeeper' | 'agent' }[],
    ): Promise<void> {
      const now = new Date().toISOString();
      for (const o of ownerIds) {
        await world.db
          .insertInto('cells')
          .values({
            id: uuidv7(),
            hive_id: world.hiveId,
            owner_id: o.id,
            owner_kind: o.kind,
            state: 'active',
            closed_at: null,
            created_at: now,
          })
          .execute();
      }
    }

    async function seedHiveDefaultRetention(world: SeedWorld, ms: number): Promise<void> {
      await world.db
        .insertInto('retention_policies')
        .values({
          id: uuidv7(),
          hive_id: world.hiveId,
          scope: 'hive',
          scope_id: null,
          unread_retention_ms: ms,
          read_retention_ms: ms,
          frozen_at: null,
          set_by: null,
        })
        .execute();
    }

    it('revokes keeper + cascades to owned agents + closes all cells (real cellsRepo)', async () => {
      // Use the real cellsHook adapter so the cascade actually mutates the cells table.
      const { createCellsRepo } = await import('#domain/cells/repository.js');
      const { createCellsHookAdapter } = await import('#composition/cells-hook-adapter.js');
      const cellsRepo = createCellsRepo(world.db);
      const hook = createCellsHookAdapter(cellsRepo);

      // Seed active cells for the non-admin keeper + their two seeded agents.
      // Use nonAdminHivekeeperId so we don't affect the admin (LAST_ADMIN_INVARIANT
      // is not yet enforced but we keep the spirit). For the cascade-via-owner test,
      // re-parent the existing agents to nonAdminHivekeeperId.
      await world.db
        .updateTable('agents')
        .set({ owner_id: world.nonAdminHivekeeperId })
        .where('id', 'in', [world.workerAgentId, world.scoutAgentId])
        .execute();
      await seedCellsFor(world, [
        { id: world.nonAdminHivekeeperId, kind: 'hivekeeper' },
        { id: world.workerAgentId, kind: 'agent' },
        { id: world.scoutAgentId, kind: 'agent' },
      ]);
      await seedHiveDefaultRetention(world, 7 * 24 * 60 * 60 * 1000);

      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });
      const result = await repo.revokeHivekeeperWithCascade(
        world.nonAdminHivekeeperId,
        SYSTEM_CALLER,
      );

      expect(result.revokedAgentIds.sort()).toEqual(
        [world.workerAgentId, world.scoutAgentId].sort(),
      );
      expect(result.closedCellIds.length).toBe(3); // keeper + 2 agents

      // Verify keeper revoked.
      const keeperRow = await world.db
        .selectFrom('hivekeepers')
        .select(['state', 'revoked_at'])
        .where('id', '=', world.nonAdminHivekeeperId)
        .executeTakeFirst();
      expect(keeperRow?.state).toBe('revoked');
      expect(keeperRow?.revoked_at).not.toBeNull();

      // Verify owned agents revoked.
      const agents = await world.db
        .selectFrom('agents')
        .select(['id', 'state'])
        .where('owner_id', '=', world.nonAdminHivekeeperId)
        .execute();
      expect(agents.every((a) => a.state === 'revoked')).toBe(true);

      // Verify cells closed.
      const cells = await world.db
        .selectFrom('cells')
        .select(['owner_id', 'state', 'closed_at'])
        .where('owner_id', 'in', [
          world.nonAdminHivekeeperId,
          world.workerAgentId,
          world.scoutAgentId,
        ])
        .execute();
      expect(cells.every((c) => c.state === 'closed')).toBe(true);
      expect(cells.every((c) => c.closed_at !== null)).toBe(true);

      // Verify retention policy snapshot inserted (no override existed → INSERT path).
      const frozenPolicy = await world.db
        .selectFrom('retention_policies')
        .selectAll()
        .where('scope', '=', 'hivekeeper')
        .where('scope_id', '=', world.nonAdminHivekeeperId)
        .executeTakeFirst();
      expect(frozenPolicy).toBeDefined();
      expect(frozenPolicy?.frozen_at).not.toBeNull();
      expect(frozenPolicy?.unread_retention_ms).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('is idempotent on a keeper already revoked (returns empty counts, no error)', async () => {
      const hook = makeSpyHook();
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });

      // First revocation.
      await repo.revokeHivekeeperWithCascade(world.nonAdminHivekeeperId, SYSTEM_CALLER);
      const firstCloseCount = hook.closeCalls.length;
      const firstCloseByOwnerCount = hook.closeByOwnerCalls.length;

      // Second revocation: should short-circuit on the WHERE state='active' guard.
      const result = await repo.revokeHivekeeperWithCascade(
        world.nonAdminHivekeeperId,
        SYSTEM_CALLER,
      );
      expect(result.revokedAgentIds).toEqual([]);
      expect(result.closedCellIds).toEqual([]);
      // The hook should NOT fire again on the no-op call.
      expect(hook.closeCalls.length).toBe(firstCloseCount);
      expect(hook.closeByOwnerCalls.length).toBe(firstCloseByOwnerCount);
    });

    it('rejects target_is_agent when given an Agent id', async () => {
      const repo = createParticipantsWriteRepo(world.db);
      try {
        await repo.revokeHivekeeperWithCascade(world.workerAgentId, SYSTEM_CALLER);
        expect.fail('expected throw');
      } catch (err) {
        expect(isAuthError(err)).toBe(true);
        const e = err as AuthError;
        expect(e.code).toBe('INVALID_STATE_TRANSITION');
        expect(e.subCode).toBe('target_is_agent');
      }
    });

    it('rolls back the cascade if cellsHook throws mid-flight (atomicity)', async () => {
      // Re-parent the seeded agents to the non-admin keeper so the cascade
      // actually has agents to revoke; otherwise the agent rollback assertion
      // below is vacuously true.
      await world.db
        .updateTable('agents')
        .set({ owner_id: world.nonAdminHivekeeperId })
        .where('id', 'in', [world.workerAgentId, world.scoutAgentId])
        .execute();

      const hookError = new Error('cell-store mid-cascade failure');
      const failingHook: CellsRepoHook = {
        createCell(): Promise<void> {
          return Promise.resolve();
        },
        closeCell(): Promise<void> {
          // Throws on the keeper close — after the keeper + agent UPDATEs ran but
          // before closeCellsByOwner. The TX must roll back the keeper + agent UPDATEs.
          return Promise.reject(hookError);
        },
        closeCellsByOwner(): Promise<void> {
          return Promise.resolve();
        },
      };
      const repo = createParticipantsWriteRepo(world.db, { cellsHook: failingHook });

      await expect(
        repo.revokeHivekeeperWithCascade(world.nonAdminHivekeeperId, SYSTEM_CALLER),
      ).rejects.toBe(hookError);

      // Atomicity: keeper must still be active.
      const keeperRow = await world.db
        .selectFrom('hivekeepers')
        .select('state')
        .where('id', '=', world.nonAdminHivekeeperId)
        .executeTakeFirst();
      expect(keeperRow?.state).toBe('active');

      // Atomicity: ALL re-parented agents (workerAgentId + scoutAgentId) must
      // still be active. This is the assertion that previously was vacuous.
      const ownedAgents = await world.db
        .selectFrom('agents')
        .select(['id', 'state'])
        .where('owner_id', '=', world.nonAdminHivekeeperId)
        .execute();
      expect(ownedAgents.length).toBe(2);
      expect(ownedAgents.every((a) => a.state === 'active')).toBe(true);
    });

    it('snapshots the hive default policy when keeper has no override', async () => {
      const hook = makeSpyHook();
      await seedHiveDefaultRetention(world, 14 * 24 * 60 * 60 * 1000);

      const repo = createParticipantsWriteRepo(world.db, { cellsHook: hook });
      await repo.revokeHivekeeperWithCascade(world.nonAdminHivekeeperId, SYSTEM_CALLER);

      const frozenPolicy = await world.db
        .selectFrom('retention_policies')
        .selectAll()
        .where('scope', '=', 'hivekeeper')
        .where('scope_id', '=', world.nonAdminHivekeeperId)
        .executeTakeFirst();
      expect(frozenPolicy).toBeDefined();
      expect(frozenPolicy?.unread_retention_ms).toBe(14 * 24 * 60 * 60 * 1000);
      expect(frozenPolicy?.read_retention_ms).toBe(14 * 24 * 60 * 60 * 1000);
      expect(frozenPolicy?.frozen_at).not.toBeNull();
    });
  });
});
