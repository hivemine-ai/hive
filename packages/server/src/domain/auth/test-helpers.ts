// Shared test fixtures for auth-domain integration tests.
// Spins up a fresh in-memory SQLite, runs migrations, and seeds a minimal world
// (one Hive, one Colony, one admin Hivekeeper, one Worker Agent).

import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { createDb } from '#persistence/db.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { generateKeypair } from './keys/keypair-store.js';
import type { SigningKey } from './keys/keypair-store.js';
import type { UUIDv7 } from './types.js';

export interface SeedWorld {
  db: Kysely<Database>;
  signingKey: SigningKey;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  adminHivekeeperId: UUIDv7;
  nonAdminHivekeeperId: UUIDv7;
  workerAgentId: UUIDv7;
  scoutAgentId: UUIDv7;
  workerCapabilities: string[];
}

export async function seedWorld(): Promise<SeedWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const adminHivekeeperId = uuidv7();
  const nonAdminHivekeeperId = uuidv7();
  const workerAgentId = uuidv7();
  const scoutAgentId = uuidv7();
  const workerCapabilities = ['cell.send', 'cell.read'];

  await db.insertInto('hives').values({ id: hiveId, name: 'Test Hive' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();
  await db
    .insertInto('hivekeepers')
    .values({
      id: adminHivekeeperId,
      hive_id: hiveId,
      colony_id: colonyId,
      email: 'admin@example.com',
      display_name: 'Admin Keeper',
      is_admin: 1,
      state: 'active',
      revoked_at: null,
    })
    .execute();
  await db
    .insertInto('hivekeepers')
    .values({
      id: nonAdminHivekeeperId,
      hive_id: hiveId,
      colony_id: colonyId,
      email: 'keeper@example.com',
      display_name: null,
      is_admin: 0,
      state: 'active',
      revoked_at: null,
    })
    .execute();
  await db
    .insertInto('agents')
    .values({
      id: workerAgentId,
      hive_id: hiveId,
      colony_id: colonyId,
      owner_id: adminHivekeeperId,
      name: 'worker-1',
      type: 'worker',
      capabilities: jsonStringify(workerCapabilities),
      instructions: 'do work',
      state: 'active',
      revoked_at: null,
    })
    .execute();
  await db
    .insertInto('agents')
    .values({
      id: scoutAgentId,
      hive_id: hiveId,
      colony_id: colonyId,
      owner_id: adminHivekeeperId,
      name: 'scout-1',
      type: 'scout',
      capabilities: jsonStringify([]),
      instructions: '',
      state: 'active',
      revoked_at: null,
    })
    .execute();

  const signingKey = generateKeypair();
  await db
    .insertInto('signing_keys')
    .values({
      kid: signingKey.kid,
      algorithm: 'EdDSA',
      public_jwk: jsonStringify(signingKey.publicKey.export({ format: 'jwk' })),
      retired_at: null,
      removed_at: null,
    })
    .execute();

  return {
    db,
    signingKey,
    hiveId,
    colonyId,
    adminHivekeeperId,
    nonAdminHivekeeperId,
    workerAgentId,
    scoutAgentId,
    workerCapabilities,
  };
}

export async function destroyWorld(world: SeedWorld): Promise<void> {
  await world.db.destroy();
}

export async function markHivekeeperRevoked(world: SeedWorld, id: UUIDv7): Promise<void> {
  await world.db
    .updateTable('hivekeepers')
    .set({ state: 'revoked', revoked_at: dateToIso(new Date()) })
    .where('id', '=', id)
    .execute();
}

export async function markAgentRevoked(world: SeedWorld, id: UUIDv7): Promise<void> {
  await world.db
    .updateTable('agents')
    .set({ state: 'revoked', revoked_at: dateToIso(new Date()) })
    .where('id', '=', id)
    .execute();
}
