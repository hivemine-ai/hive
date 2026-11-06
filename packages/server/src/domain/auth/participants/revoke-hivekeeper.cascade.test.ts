// PRY-094 review: revoking a Hivekeeper revokes every Agent it owns that is not revoked
// yet (active, suspended and retired), clears retired_at and closes their Cells, with the
// real Cell Store hook and sender. SQLite by default; set HIVE_TEST_PG_URL to run the same
// suite against Postgres (CI `postgres` job).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCellsHookAdapter } from '#composition/cells-hook-adapter.js';
import { stubVisibilityEngine } from '#composition/stubs.js';
import { createCellEvents, createCellsRepo, createSender } from '#domain/cells/index.js';
import type { CellsRepo, Sender } from '#domain/cells/index.js';
import { createBlocklist } from '#domain/auth/credentials/blocklist.js';
import { createIssuer } from '#domain/auth/credentials/issuer.js';
import { createVerifier } from '#domain/auth/credentials/verifier.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { createParticipantsWriteRepo } from '#domain/auth/participants/repository.write.js';
import { createParticipantStateSignal } from '#domain/auth/participants/state-signal.js';
import type { ParticipantStateChange } from '#domain/auth/participants/state-signal.js';
import type { ParticipantsWriteRepo } from '#domain/auth/participants/repository.write.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { IdentityContext } from '../types.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];

describe(`revokeHivekeeperWithCascade over every live state (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SeedWorld;
  let cellsRepo: CellsRepo;
  let writeRepo: ParticipantsWriteRepo;
  let sender: Sender;
  let senderIdentity: IdentityContext;
  let changes: ParticipantStateChange[];
  let activeId: string;

  beforeEach(async () => {
    world = await seedWorld({ pgUrl: PG_URL });
    cellsRepo = createCellsRepo(world.db);
    const cellsHook = createCellsHookAdapter(cellsRepo);
    const signal = createParticipantStateSignal();
    changes = [];
    signal.onParticipantStateChanged((change) => changes.push(change));
    writeRepo = createParticipantsWriteRepo(world.db, { cellsHook, stateSignal: signal });

    // seedWorld writes rows without Cells: give every participant its Cell.
    for (const [ownerId, ownerKind] of [
      [world.adminHivekeeperId, 'hivekeeper'],
      [world.nonAdminHivekeeperId, 'hivekeeper'],
      [world.workerAgentId, 'agent'],
      [world.scoutAgentId, 'agent'],
    ] as const) {
      await cellsHook.createCell(world.db, {
        ownerId,
        ownerKind,
        hiveId: world.hiveId,
        colonyId: world.colonyId,
      });
    }
    const active = await writeRepo.createAgent(
      {
        hiveId: world.hiveId,
        colonyId: world.colonyId,
        ownerId: world.adminHivekeeperId,
        name: 'still-active',
        type: 'worker',
      },
      { kind: 'system' },
    );
    activeId = active.id;
    await world.db
      .updateTable('agents')
      .set({ state: 'retired', retired_at: new Date().toISOString() })
      .where('id', '=', world.workerAgentId)
      .execute();
    await world.db
      .updateTable('agents')
      .set({ state: 'suspended' })
      .where('id', '=', world.scoutAgentId)
      .execute();

    const participantsRepo = createParticipantsReadRepo(world.db);
    const credential = await createIssuer({
      signingKey: world.signingKey,
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 300_000,
      db: world.db,
    }).issueCredential({ participantId: world.nonAdminHivekeeperId });
    senderIdentity = await createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist: createBlocklist(world.db),
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
    }).verify(`Bearer ${credential.jwt}`);
    sender = createSender({
      cellsRepo,
      visibilityEngine: stubVisibilityEngine,
      events: createCellEvents(),
      db: world.db,
      config: { dialect: PG_URL ? 'postgres' : 'sqlite' },
    });
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('revokes active, suspended and retired Agents, clears retired_at and closes their Cells', async () => {
    const owned = [activeId, world.workerAgentId, world.scoutAgentId];

    const result = await writeRepo.revokeHivekeeperWithCascade(world.adminHivekeeperId, {
      kind: 'system',
    });

    expect(new Set(result.revokedAgentIds)).toEqual(new Set(owned));
    const rows = await world.db
      .selectFrom('agents')
      .select(['id', 'state', 'retired_at'])
      .where('owner_id', '=', world.adminHivekeeperId)
      .execute();
    for (const row of rows) expect([row.state, row.retired_at]).toEqual(['revoked', null]);
    for (const ownerId of [world.adminHivekeeperId, ...owned]) {
      expect((await cellsRepo.findCellByOwner(ownerId))?.state).toBe('closed');
    }
    expect(new Set(result.closedCellIds).size).toBe(4);
    expect(new Set(changes.map((c) => `${c.participantId}:${c.newState}`))).toEqual(
      new Set([world.adminHivekeeperId, ...owned].map((id) => `${id}:revoked`)),
    );
  });

  it('a send to a formerly retired or suspended Agent fails as for any revoked recipient', async () => {
    await writeRepo.revokeHivekeeperWithCascade(world.adminHivekeeperId, { kind: 'system' });

    for (const recipientId of [world.workerAgentId, world.scoutAgentId]) {
      await expect(
        sender.sendMessage({
          callerContext: senderIdentity,
          recipientId,
          type: 'notification',
          body: 'after the owner left',
        }),
      ).rejects.toMatchObject({ code: 'RECIPIENT_UNREACHABLE' });
    }
  });
});
