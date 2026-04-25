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

> _Coming in v0.1.0. The repository is being bootstrapped — packages are intentionally empty._

For now, the project is in active scaffolding. To follow along:

```bash
nvm use            # switches to the Node version pinned in .nvmrc
pnpm install
pnpm typecheck
pnpm lint
```

### Planned deploy paths (v0.1.0)

- **Local / OSS default:** `pnpm install -g @hive/cli` + `hivectl init` → SQLite at `./var/db/hive.sqlite`. No Docker, no infra.
- **Production (opt-in):** `docker compose up` with `COMPOSE_PROFILES=postgres` → Postgres-backed deployment.

PostgreSQL support ships in v0.1.0 (the persistence layer is multi-dialect from day one), but is officially validated in CI starting v0.1.1.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commit conventions, and the PR workflow.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attributions.
