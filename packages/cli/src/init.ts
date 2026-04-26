// hivectl init — bootstrap a new Hive end-to-end.
// Per PRY-002 Hito 21:
//   1. Connect to the configured DB.
//   2. Run Kysely.Migrator.migrateToLatest().
//   3. Acquire `hive_init` distributed lock (race guard).
//   4. Re-check that no Hive exists; if it does, throw HIVE_ALREADY_INITIALIZED.
//   5. Generate Ed25519 signing key + persist PEMs (mode 0600) + signing_keys row.
//   6. Insert hives + colonies + first admin Hivekeeper rows in a transaction.
//   7. Issue the first credential via the issuer.
//   8. Release the lock and return everything to the caller.
//
// On HIVE_ALREADY_INITIALIZED, no DB state is modified beyond what migrations did.

import {
  acquireLock,
  AuthError,
  boolToInt,
  createCellsRepo,
  createDb,
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  dateToIso,
  generateKeypair,
  jsonStringify,
  migrateToLatest,
  releaseLock,
  resolveDbConfigFromEnv,
  uuidv7,
  writeKeypairToDisk,
  type CallerContext,
  type DbConfig,
  type IssuedCredential,
  type SigningKey,
  type UUIDv7,
} from '@hive/server';

const INIT_LOCK_ID = 'hive_init';
const INIT_LOCK_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

export interface InitOptions {
  /** Database URL or fully-resolved DbConfig. */
  db: string | DbConfig;
  hiveName?: string;
  adminEmail: string;
  adminDisplayName?: string;
  keysDir: string;
  ttlMs?: number;
  osUser?: string;
  operatorNote?: string;
  /** For tests: inject a deterministic signing key. */
  signingKeyOverride?: SigningKey;
}

export interface InitResult {
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  adminHivekeeperId: UUIDv7;
  signingKey: SigningKey;
  initialCredential: IssuedCredential;
}

export async function performInit(opts: InitOptions): Promise<InitResult> {
  const dbConfig =
    typeof opts.db === 'string' ? resolveDbConfigFromEnv({ HIVE_DB_URL: opts.db }) : opts.db;
  const db = createDb(dbConfig);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  try {
    // Step 1-2: schema.
    await migrateToLatest(db);

    // Step 3: acquire init lock (post-migrations so the locks table exists).
    const lockOwner = uuidv7();
    const acquired = await acquireLock(db, {
      lockId: INIT_LOCK_ID,
      ownerId: lockOwner,
      ttlMs: INIT_LOCK_TTL_MS,
    });
    if (!acquired) {
      throw new AuthError('HIVE_ALREADY_INITIALIZED', {
        subCode: 'init_in_progress',
      });
    }

    try {
      // Step 4: idempotency check inside the lock.
      const existing = await db.selectFrom('hives').select('id').limit(1).execute();
      if (existing.length > 0) {
        throw new AuthError('HIVE_ALREADY_INITIALIZED');
      }

      // Step 5: signing key.
      const signingKey = opts.signingKeyOverride ?? generateKeypair();
      await writeKeypairToDisk({ keysDir: opts.keysDir }, signingKey);
      const now = new Date();
      await db
        .insertInto('signing_keys')
        .values({
          kid: signingKey.kid,
          algorithm: 'EdDSA',
          public_jwk: jsonStringify(signingKey.publicKey.export({ format: 'jwk' })),
          created_at: dateToIso(now),
          retired_at: null,
          removed_at: null,
        })
        .execute();

      // Step 6: hive + colony + first admin Hivekeeper, all in one transaction.
      const hiveId = uuidv7();
      const colonyId = uuidv7();
      const adminHivekeeperId = uuidv7();

      const cellsRepo = createCellsRepo(db);
      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('hives')
          .values({
            id: hiveId,
            name: opts.hiveName ?? 'Hive',
            created_at: dateToIso(now),
          })
          .execute();
        await tx
          .insertInto('colonies')
          .values({
            id: colonyId,
            hive_id: hiveId,
            name: 'default',
            created_at: dateToIso(now),
          })
          .execute();
        await tx
          .insertInto('hivekeepers')
          .values({
            id: adminHivekeeperId,
            hive_id: hiveId,
            colony_id: colonyId,
            email: opts.adminEmail,
            display_name: opts.adminDisplayName ?? null,
            is_admin: boolToInt(true),
            state: 'active',
            created_at: dateToIso(now),
            revoked_at: null,
          })
          .execute();
        await cellsRepo.createCell(
          { ownerId: adminHivekeeperId, ownerKind: 'hivekeeper', hiveId },
          tx,
        );
      });

      // Step 7: initial credential for the admin Hivekeeper.
      const repo = createParticipantsReadRepo(db);
      const issuer = createIssuer({
        signingKey,
        participantsRepo: repo,
        hiveStableIdentifier: hiveId,
        defaultTtlMs: ttlMs,
        db,
      });
      const initialCredential = await issuer.issueCredential({
        participantId: adminHivekeeperId,
        ttl: ttlMs,
      });

      return {
        hiveId,
        colonyId,
        adminHivekeeperId,
        signingKey,
        initialCredential,
      };
    } finally {
      await releaseLock(db, {
        lockId: INIT_LOCK_ID,
        ownerId: lockOwner,
      });
    }
  } finally {
    await db.destroy();
  }
}

// Re-export the canonical system caller helper for test callers and CLI handlers.
export function buildSystemCaller(osUser?: string, operatorNote?: string): CallerContext {
  const caller: CallerContext = { kind: 'system' };
  if (osUser !== undefined) caller.osUser = osUser;
  if (operatorNote !== undefined) caller.operatorNote = operatorNote;
  return caller;
}

// Re-export for downstream consumers.
export {
  createDb,
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  generateKeypair,
};
