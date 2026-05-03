# Hive

> Open-source MCP server for collaborative AI agents.
>
> **Status:** v0.1 — under active development. Not yet released.

Hive is a self-hostable Model Context Protocol (MCP) server that gives teams of AI agents a shared mailbox, an identity model, and a notification fabric.

## Stack

- **Runtime:** Node.js 20 LTS (see `.nvmrc`)
- **Language:** TypeScript (strict)
- **Database:** **SQLite (default, via CLI — zero infra)** or PostgreSQL 16+ (opt-in, for Docker / production deploys)
- **Persistence layer:** [Kysely](https://kysely.dev) (type-safe SQL, multi-dialect) + `better-sqlite3` (default) or `pg` (opt-in)
- **MCP transport:** [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) over Streamable HTTP, hosted by [`fastify`](https://fastify.dev). Full 8-tool catalog ships in v0.1: `get_agent_config`, `send_message`, `reply_to`, `read_mailbox`, `mark_read`, `check_unread_messages`, `list_agents`, `get_agent_status`.
- **CLI framework:** [`commander`](https://github.com/tj/commander.js) (subcommand tree) + [`yaml`](https://eemeli.org/yaml/) (output) + [`chalk`](https://github.com/chalk/chalk) (terminal palette, single source in `output/colors.ts` per ADR-021) for `hivectl`. Migrations via `Kysely.Migrator` (portable SQLite/PG).
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
# Install the self-contained binary (no Node runtime required at the install host).
npm install -g @hivemine/hivectl

# 1. Bootstrap a fresh Hive (one-time). SQLite at ./var/db/hive.sqlite by default.
hivectl init --admin-email you@example.com --output-credential admin.jwt

# 2. Run the MCP server in the foreground (blocks until SIGINT/SIGTERM).
hivectl serve
# → Listening on http://127.0.0.1:8443/mcp

# Endpoints: POST/GET/DELETE /mcp, GET /healthz, GET /readyz, GET /.well-known/jwks.json
# See docs/mcp-server.md for the full operator guide.
```

For OS-supervised deployments (systemd on Linux, launchd on macOS) use `hivectl service install` instead of `hivectl serve`. Common admin operations:

```bash
hivectl hivekeeper create --email teammate@example.com --emit-credential
hivectl agent create --owner you@example.com --name worker-a --type worker --emit-credential
hivectl credential rotate worker-a@you.cotalker:latest --yes
hivectl audit query --limit 20
```

Full operator surface (10 subcommand groups: `init` / `migrate` / `serve` / `service` / `config` / `hive` / `hivekeeper` / `agent` / `credential` / `audit`) is documented in [`docs/hivectl.md`](./docs/hivectl.md).

### Distribution

Hive is **OSS** (Apache 2.0). The release pipeline ships `hivectl` as a self-contained SEA binary (~108 MB, no Node runtime needed at the install host) under `npm install -g @hivemine/hivectl`, with per-platform packages for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Releases are cut via the `release.yml` workflow in this repo.

### Deploy paths

Per ADR-008 the deploy story bifurcates into two topologies:

- **Topology 1 — CLI + SQLite (default).** `npm install -g @hivemine/hivectl` + `hivectl init` → SQLite at `/var/lib/hive/hive.sqlite` (Linux) or `~/Library/Application Support/Hive/hive.sqlite` (macOS). Zero infra. Process supervised by `hivectl service install` (systemd on Linux, launchd on macOS). Documented in [`packages/cli/README.md`](./packages/cli/README.md) and [`docs/hivectl.md`](./docs/hivectl.md).
- **Topology 2 — Docker Compose (Postgres-backed).** `docker compose -f deployment/docker-compose.yml up -d` against the bundled image. SQLite-in-volume by default; activate `--profile postgres` to add the Postgres service. Full operator guide in [`deployment/README.md`](./deployment/README.md).

PostgreSQL support ships in v0.1.0 (the persistence layer is multi-dialect from day one), but is officially validated end-to-end in CI starting v0.1.1.

### Building from source (contributors)

If you are hacking on Hive itself rather than running it, see [`packages/cli/README.md`](./packages/cli/README.md) for the dev-mode flow (`pnpm install && pnpm build` + `node packages/cli/dist/main.js <args>`) and the SEA build pipeline (`pnpm --filter @hive/cli sea:build:darwin | sea:build:linux`). [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers the PR workflow, commit conventions, and lint hooks.

## Documentation

User-facing component documentation lives in [`docs/`](./docs/README.md). Each package also has its own README:

- [`@hive/server`](./packages/server/README.md) — auth + persistence + domain logic.
- [`@hive/cli`](./packages/cli/README.md) — `hivectl` admin CLI.
- [`@hive/client`](./packages/client/README.md) — reusable client library.
- [`@hive/shared`](./packages/shared/README.md) — cross-package types.

Architecture decisions, tech specs, and product specs live in the [vault](https://github.com/hivemine-ai/hive-vault), not in this repo.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commit conventions, and the PR workflow.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attributions.
