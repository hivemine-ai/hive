# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial repository scaffold: pnpm workspaces mono-repo (`server`, `cli`, `client`, `shared`).
- TypeScript strict configuration (`tsconfig.base.json`).
- ESLint flat config + Prettier + husky pre-commit hooks.
- GitHub Actions PR workflow (typecheck + lint).
- Issue templates, pull request template, CODEOWNERS.
- Apache License 2.0 + NOTICE.

### Changed

- **Persistence strategy (architectural):** SQLite is now the default database (zero-infra, CLI-driven). PostgreSQL becomes opt-in for Docker / production deploys. The persistence layer is built on [Kysely](https://kysely.dev) (multi-dialect, type-safe SQL) so the same code runs on both backends. PostgreSQL ships working in v0.1.0 but is officially validated in CI starting v0.1.1.
- **Internal imports use the Node `imports` field aliases** (PRY-009): cross-module imports inside `@hive/server` now use `#persistence/*`, `#domain/*`, `#observability/*` instead of `../../`. ESLint `no-restricted-imports` enforces the convention — relative cross-module specifiers fail CI. Per ADR-009.

### Added (v0.1.0 progress)

- **Auth + Identity subsystem** (PRY-002): 7-step JWT verifier with full mapping of `jose` exceptions to 13 semantic error codes; Ed25519 keypair store with `kid` derived from SPKI DER bytes; persistent + in-memory blocklist; issuer / rotator / revoker with atomic transactions. Per [ADR-007](https://github.com/hivemine-ai/hive-vault) (CallerContext) and [ADR-008](https://github.com/hivemine-ai/hive-vault) (persistence layer).
- **Admin participant management** (PRY-002): `createHivekeeper`, `createAgent` (with cross-domain hook for Cell Store), `revokeAgent` (idempotent), `listAgents` and `listHivekeepers` with portable keyset pagination.
- **`hivectl init`** (PRY-002): bootstraps a fresh Hive end-to-end on SQLite (default) or Postgres. Idempotent against a non-empty DB (throws `HIVE_ALREADY_INITIALIZED`).
- **Persistence layer foundation** (PRY-002): Kysely + dialect detection (`createDb`), portable `acquireLock` primitive (replaces `pg_advisory_lock`), `Kysely.Migrator` with static migration catalog, type mappers for ISO 8601 timestamps + JSON snapshots.
- **Per-package READMEs** and `docs/` user-facing component documentation, anchored on [`docs/auth.md`](./docs/README.md).
