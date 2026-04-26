import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { Kysely } from 'kysely';

import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';
import { createCellsRepo } from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';

import { createCellsHookAdapter } from './cells-hook-adapter.js';

interface AdapterWorld {
  db: Kysely<Database>;
  cellsRepo: CellsRepo;
  hiveId: string;
  colonyId: string;
}

async function seedAdapterWorld(): Promise<AdapterWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'Adapter Test Hive' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();

  const cellsRepo = createCellsRepo(db);
  return { db, cellsRepo, hiveId, colonyId };
}

describe('createCellsHookAdapter', () => {
  let world: AdapterWorld;

  beforeEach(async () => {
    world = await seedAdapterWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  describe('createCell', () => {
    it('inserts a cell row with the right ownerKind/hiveId', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();
      await adapter.createCell(world.db, {
        ownerId,
        ownerKind: 'agent',
        hiveId: world.hiveId,
        colonyId: world.colonyId,
      });

      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell).not.toBeNull();
      expect(cell?.ownerId).toBe(ownerId);
      expect(cell?.ownerKind).toBe('agent');
      expect(cell?.hiveId).toBe(world.hiveId);
      expect(cell?.state).toBe('active');
      expect(cell?.closedAt).toBeNull();
    });

    it('inserts a hivekeeper-owned cell when ownerKind is hivekeeper', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();
      await adapter.createCell(world.db, {
        ownerId,
        ownerKind: 'hivekeeper',
        hiveId: world.hiveId,
        colonyId: world.colonyId,
      });

      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell?.ownerKind).toBe('hivekeeper');
    });
  });

  describe('closeCell', () => {
    it('closes an existing cell by ownerId', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();
      await adapter.createCell(world.db, {
        ownerId,
        ownerKind: 'agent',
        hiveId: world.hiveId,
        colonyId: world.colonyId,
      });

      await adapter.closeCell(world.db, { ownerId });

      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell?.state).toBe('closed');
      expect(cell?.closedAt).toBeInstanceOf(Date);
    });

    it('is idempotent on a re-close (no error, state stays closed)', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();
      await adapter.createCell(world.db, {
        ownerId,
        ownerKind: 'agent',
        hiveId: world.hiveId,
        colonyId: world.colonyId,
      });
      await adapter.closeCell(world.db, { ownerId });

      // Second close — must be a no-op, no throw.
      await expect(adapter.closeCell(world.db, { ownerId })).resolves.toBeUndefined();

      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell?.state).toBe('closed');
    });

    it('is a no-op for an unknown ownerId (no throw, no row affected)', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const unknown = uuidv7();
      await expect(adapter.closeCell(world.db, { ownerId: unknown })).resolves.toBeUndefined();
      expect(await world.cellsRepo.findCellByOwner(unknown)).toBeNull();
    });
  });

  describe('participates in caller transaction', () => {
    it('rollback of the parent TX rolls back the cell row', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();

      await expect(
        world.db.transaction().execute(async (tx) => {
          await adapter.createCell(tx, {
            ownerId,
            ownerKind: 'agent',
            hiveId: world.hiveId,
            colonyId: world.colonyId,
          });
          throw new Error('boom — rollback parent TX');
        }),
      ).rejects.toThrow(/boom/);

      // The cell write must have been rolled back with the parent TX.
      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell).toBeNull();
    });
  });

  describe('CreateCellHookInput.colonyId is intentionally dropped', () => {
    it('accepts colonyId in the hook input without persisting or erroring', async () => {
      const adapter = createCellsHookAdapter(world.cellsRepo);
      const ownerId = uuidv7();
      const colonyId = uuidv7(); // arbitrary — cells table has no colony_id column.

      await adapter.createCell(world.db, {
        ownerId,
        ownerKind: 'agent',
        hiveId: world.hiveId,
        colonyId,
      });

      // Cell created successfully; the schema-side absence of colony_id is the
      // contract — adapter must not blow up nor try to persist the field.
      const cell = await world.cellsRepo.findCellByOwner(ownerId);
      expect(cell).not.toBeNull();
      expect(cell?.ownerKind).toBe('agent');
    });
  });
});
