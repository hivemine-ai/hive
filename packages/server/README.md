# @hive/server

> The Hive core: persistence, domain logic, JWT auth pipeline. Consumed by `@hive/cli` and (later) by the MCP transport.

## Purpose

This is the heart of a Hive deploy. As of v0.1 it implements:

- **Persistence layer** — Kysely + dialect detection (SQLite default, Postgres opt-in), portable `acquireLock` primitive, `Kysely.Migrator` with a static migration catalog.
- **Auth + Identity** — Ed25519 keypair store, 7-step JWT verifier, issuer / rotator / revoker, persistent blocklist with in-memory hot path.
- **Participants** — Hivekeepers and Agents (Workers, Scouts) with admin operations gated by `CallerContext` discriminated union ([ADR-007](https://github.com/hivemine-ai/hive-vault)).
- **Cell Store + Message Persistence (Slice 0)** — mailbox-per-participant. `sendMessage` / `readMailbox` / `markRead` with idempotency, keyset pagination, uniform privacy. Cross-PRY ops `summarizeUnreadForCell` (consumed by Waggle) and `findMessageById` (consumed by MCP `reply_to`). Cross-domain hook from Auth fully wired.
- **Visibility Engine + Audit Log (Slice 0)** — `canSend` / `canSee` evaluating the 18-row product matrix; append-only audit log with fire-and-forget recorder + per-category failure counter. Composition root wires the production engine; the always-allow stub is reserved for unit tests.
- **Waggle Pipeline + Presence Registry (Slice 0)** — push notifications subsystem. In-memory Presence Registry (`subscribe`, `unsubscribe`, `getPresence`, `forEachSubscriber`); quiet-window consolidator (per-Cell, default 500ms); replay path on subscribe (per-subscription, not fan-out); pipeline subscribed to Cell Store events. The `SubscriberHandle` interface is implemented by the (future) MCP transport in PRY-006.
- **Observability** — pino + pino-pretty (auto dev-mode via `NODE_ENV`).

It does **not** implement: the MCP transport surface or `hivectl` itself beyond `init`. Those land in PRYs 006–008. Cell Store admin ops (retention policies, expiration job, sweep, audit log purge job, paginated audit query) are deferred to Slice 1+.

## Public API

The package barrel (`./src/index.ts`) exports:

- **Persistence:** `createDb`, `resolveDbConfigFromEnv`, `migrateToLatest`, `migrateDown`, `acquireLock`, `releaseLock`, `sweepExpiredLocks`, `dateToIso` and friends.
- **Auth domain:** `AuthError`, `isAuthError`, `createVerifier`, `createIssuer`, `createRotator`, `createRevoker`, `createParticipantsReadRepo`, `createParticipantsWriteRepo`, `loadBlocklist`, `requireAdminCaller`, `generateKeypair`, `writeKeypairToDisk`, `loadAllKeypairs`, `assertPrivatePemPerms`, `buildJwkSet`, plus types: `SigningKey`, `IdentityContext`, `CallerContext`, `Participant`, `Hivekeeper`, `Agent`.
- **Cells domain:** `createCellsRepo`, `createSender`, `createReader`, `createCellEvents`, `CellError`, `isCellError`, `mapKindToOwnerKind`, plus types: `Cell`, `Message`, `MessageView`, `MessageType`, `MessageState`, `CellState`, `SendMessageInput`, `SendResult`, `ReadMailboxInput`, `MarkReadInput`, `MarkReadResult`, `RetentionPolicy`, `SummarizeUnreadResult`.
- **Visibility domain:** `createVisibilityEngine`, `createVisibilityEngineForProduction`, `stubVisibilityEngine`, plus types: `VisibilityEngine`, `CanSendInput`, `CanSeeInput`, `DenialReason`, `SenderClass`, `RecipientClass`.
- **Audit domain:** `createAuditRepo`, `createAuditRecorder`, `getAuditRecordFailureCount`, `resetAuditRecordFailureCounters`, plus types: `AuditEvent`, `NewAuditEvent`, `AuditEventCategory`, `AuditError`.
- **Notifications domain (Waggle + Presence):** `createPresenceRegistry`, `createConsolidator`, `createBuilder`, `createReplay`, `createPipeline`, `createNotificationsForProduction`, `WaggleError`, `isWaggleError`, plus types: `SubscriberHandle`, `SubscribeInput`, `Subscription`, `PresenceSnapshot`, `WaggleNotification`, `WaggleKind`, `Notifications`.
- **Observability:** `createLogger`.
- **Convenience re-export:** `uuidv7` (RFC 9562).

## Documentation

See [`docs/auth.md`](../../docs/auth.md) for the auth subsystem from a user's point of view (what JWTs look like, error codes, env vars).

## Internal layout

Cross-module imports inside this package use the Node `imports` field aliases declared in [`package.json`](./package.json):

- `#persistence/*` → `./dist/persistence/*`
- `#domain/*` → `./dist/domain/*`
- `#observability/*` → `./dist/observability/*`
- `#composition/*` → `./dist/composition/*` (cross-domain hook adapter, visibility stub)

Relative cross-module specifiers (`../../foo`) are blocked by ESLint (`no-restricted-imports`); use the alias instead. See ADR-009 in the vault for rationale.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
