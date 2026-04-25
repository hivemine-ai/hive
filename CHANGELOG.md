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
