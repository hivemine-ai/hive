# Hive

> Open-source MCP server for collaborative AI agents.
>
> **Status:** v0.1 — under active development. Not yet released.

Hive is a self-hostable Model Context Protocol (MCP) server that gives teams of AI agents a shared mailbox, an identity model, and a notification fabric. It is the open-source core that the upcoming Hivemine SaaS will build on.

## Stack

- **Runtime:** Node.js 20 LTS (see `.nvmrc`)
- **Language:** TypeScript (strict)
- **Database:** **SQLite (default, via CLI — zero infra)** or PostgreSQL 16+ (opt-in, for Docker / production deploys)
- **Persistence layer:** [Kysely](https://kysely.dev) (type-safe SQL, multi-dialect) + `better-sqlite3` (default) or `pg` (opt-in)
- **Containerization:** Docker + Docker Compose, _optional_ — only needed for Postgres-backed deploys
- **Package manager:** pnpm 10 (see `packageManager` field)

## Repository layout

This is a [pnpm workspaces](https://pnpm.io/workspaces) mono-repo:

```
packages/
├── server/    # MCP server, domain logic, persistence
├── cli/       # hivectl — admin CLI
├── client/    # reusable client library
└── shared/    # shared types and constants
deployment/    # Docker Compose + reference config (PRY-008)
docs/          # public documentation
```

## Quick start

```bash
nvm use            # switches to the Node version pinned in .nvmrc
pnpm install
pnpm build         # compiles all packages (project references)
pnpm test          # runs the suite (vitest)
```

> v0.1 is under active development. The auth subsystem and CLI bootstrap (`hivectl init`) are functional; Cell Store, Visibility, Waggle, MCP transport, and full `hivectl` surface land in PRYs 003–007.

### Planned deploy paths (v0.1.0)

- **Local / OSS default:** `pnpm install -g @hive/cli` + `hivectl init` → SQLite at `./var/db/hive.sqlite`. No Docker, no infra.
- **Production (opt-in):** `docker compose up` with `COMPOSE_PROFILES=postgres` → Postgres-backed deployment (lands in PRY-008).

PostgreSQL support ships in v0.1.0 (the persistence layer is multi-dialect from day one), but is officially validated in CI starting v0.1.1.

## Documentation

User-facing component documentation lives in [`docs/`](./docs/README.md). Each package also has its own README:

- [`@hive/server`](./packages/server/README.md) — auth + persistence + domain logic.
- [`@hive/cli`](./packages/cli/README.md) — `hivectl` admin CLI.
- [`@hive/client`](./packages/client/README.md) — reusable client library (lands in PRY-006).
- [`@hive/shared`](./packages/shared/README.md) — cross-package types.

Architecture decisions, tech specs, and product specs live in the [vault](https://github.com/hivemine-ai/hive-vault), not in this repo.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commit conventions, and the PR workflow.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attributions.
