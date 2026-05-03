// hivectl init — bootstrap a new Hive end-to-end.
// Per PRY-002 milestone 21:
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
  createLogger,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createSnapshotWriter,
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
  type Logger,
  type SigningKey,
  type UUIDv7,
} from '@hive/server';

const INIT_LOCK_ID = 'hive_init';
const INIT_LOCK_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

/**
 * Tagged-union of bootstrap phases visible to the operator. Each variant is
 * emitted by `performInit` exactly once after that phase succeeds — failures
 * cause the function to throw without an event for the in-flight phase, and
 * the caller's catch path renders the error.
 *
 * Used by `commands/init.ts::runInit` to drive the 5-step ceremonial output
 * defined in the PRY-052 tech spec slice 5. Tests pass a recording callback
 * to assert the sequence of events.
 */
export type InitPhaseEvent =
  | { kind: 'database' }
  | { kind: 'migrations'; appliedCount: number }
  | { kind: 'signing-key'; kid: string }
  | { kind: 'admin-hivekeeper'; adminId: UUIDv7; adminEmail: string }
  | { kind: 'root-credential'; jti: UUIDv7; expiresAt: Date };

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
  /**
   * Optional logger for the bootstrap. Defaults to a silent pino instance.
   * Used by the snapshot writer to surface write failures (best-effort UX).
   */
  logger?: Logger;
  /**
   * Optional callback invoked once per visible bootstrap phase after that
   * phase succeeds. Used by the CLI ceremonial output (pretty mode) and by
   * tests that assert phase ordering. Failures bypass this callback —
   * the error is propagated by `throw` and the caller's error path emits
   * a single `error: ...` line (no half-rendered phase row).
   */
  onPhase?: (event: InitPhaseEvent) => void;
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

  // The five phases below map 1:1 to the rows of the ceremonial output.
  // `database` fires after `createDb` returns (which happens above, before
  // this try block) so the event surface here covers steps 2–5. We emit
  // step 1 immediately on entry — `createDb` itself does not perform I/O
  // until the first query, so a failure to "open" surfaces during
  // `migrateToLatest`. Reporting "database" up front matches the operator
  // mental model: the row appears as soon as the URL is resolved.
  opts.onPhase?.({ kind: 'database' });

  try {
    // Phase 2: migrations.
    const migResult = await migrateToLatest(db);
    opts.onPhase?.({
      kind: 'migrations',
      appliedCount: migResult.results?.length ?? 0,
    });

    // Acquire init lock (post-migrations so the locks table exists). The
    // lock is infrastructure — no ceremonial row.
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
      // Idempotency check inside the lock — also infrastructure.
      const existing = await db.selectFrom('hives').select('id').limit(1).execute();
      if (existing.length > 0) {
        throw new AuthError('HIVE_ALREADY_INITIALIZED');
      }

      // Phase 3: signing key.
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
      opts.onPhase?.({ kind: 'signing-key', kid: signingKey.kid });

      // Phase 4: hive + colony + first admin Hivekeeper, all in one transaction.
      const hiveId = uuidv7();
      const colonyId = uuidv7();
      const adminHivekeeperId = uuidv7();

      // cellsRepo is bound to the outer `db` but every method we call inside
      // the bootstrap TX below MUST forward the `tx` executor explicitly.
      // Calling cellsRepo.<method>(...) without `tx` would silently bypass the
      // bootstrap transaction and break atomicity of the hive+admin+cell write.
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
      opts.onPhase?.({
        kind: 'admin-hivekeeper',
        adminId: adminHivekeeperId,
        adminEmail: opts.adminEmail,
      });

      // Phase 5: initial credential for the admin Hivekeeper.
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
      opts.onPhase?.({
        kind: 'root-credential',
        jti: initialCredential.jti,
        expiresAt: initialCredential.expiresAt,
      });

      // Step 8: write the initial status snapshot (per ADR-022). The CLI
      // cold start (Slice 2) reads this file zero-network. `init` runs
      // outside the server lifecycle, so `server: null` reflects reality
      // (no MCP server running). Best-effort — write failures log but do
      // not fail the bootstrap.
      const snapshotLogger = opts.logger ?? createLogger({ level: 'silent' });
      const snapshotWriter = createSnapshotWriter({
        db,
        hiveId,
        dbConfig,
        logger: snapshotLogger,
      });
      await snapshotWriter.writeWithoutServer();

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
