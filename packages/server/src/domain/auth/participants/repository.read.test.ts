import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { createParticipantsReadRepo } from './repository.js';

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
});
