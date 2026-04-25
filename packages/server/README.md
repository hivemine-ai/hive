# @hive/server

> The Hive core: persistence, domain logic, JWT auth pipeline. Consumed by `@hive/cli` and (later) by the MCP transport.

## Purpose

This is the heart of a Hive deploy. As of v0.1 it implements:

- **Persistence layer** — Kysely + dialect detection (SQLite default, Postgres opt-in), portable `acquireLock` primitive, `Kysely.Migrator` with a static migration catalog.
- **Auth + Identity** — Ed25519 keypair store, 7-step JWT verifier, issuer / rotator / revoker, persistent blocklist with in-memory hot path.
- **Participants** — Hivekeepers and Agents (Workers, Scouts) with admin operations gated by `CallerContext` discriminated union ([ADR-007](https://github.com/hivemine-ai/hive-vault)).
- **Observability** — pino + pino-pretty (auto dev-mode via `NODE_ENV`).

It does **not** implement: the MCP transport surface, Cell Store, Visibility Engine, Waggle, or `hivectl` itself. Those land in PRYs 003–008.

## Public API

The package barrel (`./src/index.ts`) exports:

- **Persistence:** `createDb`, `resolveDbConfigFromEnv`, `migrateToLatest`, `migrateDown`, `acquireLock`, `releaseLock`, `sweepExpiredLocks`, `dateToIso` and friends.
- **Auth domain:** `AuthError`, `isAuthError`, `createVerifier`, `createIssuer`, `createRotator`, `createRevoker`, `createParticipantsReadRepo`, `createParticipantsWriteRepo`, `loadBlocklist`, `requireAdminCaller`, `generateKeypair`, `writeKeypairToDisk`, `loadAllKeypairs`, `assertPrivatePemPerms`, `buildJwkSet`, plus types: `SigningKey`, `IdentityContext`, `CallerContext`, `Participant`, `Hivekeeper`, `Agent`.
- **Observability:** `createLogger`.
- **Convenience re-export:** `uuidv7` (RFC 9562).

## Documentation

See [`docs/auth.md`](../../docs/auth.md) for the auth subsystem from a user's point of view (what JWTs look like, error codes, env vars).

## License

Apache-2.0. See [NOTICE](../../NOTICE).
