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
- **MCP transport:** [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) over Streamable HTTP, hosted by [`fastify`](https://fastify.dev). 5 tools shipped in v0.1 Slice 0 (`get_agent_config`, `send_message`, `read_mailbox`, `mark_read`, `check_unread_messages`); the remaining 3 (`reply_to`, `list_agents`, `get_agent_status`) land in Slice 1+.
- **CLI framework:** [`commander`](https://github.com/tj/commander.js) (subcommand tree) + [`yaml`](https://eemeli.org/yaml/) (output) for `hivectl`. Migrations via `Kysely.Migrator` (portable SQLite/PG).
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

Once `v0.1.0` is published to npm, the supported install path is:

```bash
npm install -g @hivemine/hivectl                                    # self-contained binary; no Node runtime required at runtime
hivectl init --admin-email you@example.com                          # one-time bootstrap
hivectl serve                                                        # foreground MCP server
# → Listening on http://127.0.0.1:8443/mcp
```

Until then (and for contributors hacking on the codebase), build from source:

```bash
nvm use            # switches to the Node version pinned in .nvmrc
pnpm install
pnpm build         # compiles all packages (project references)
pnpm test          # runs the suite (vitest)
```

> v0.1 is under active development. The auth subsystem, Cell Store, Visibility / Audit, Waggle pipeline, and MCP transport are functional (Slice 0). The full `hivectl` admin surface and Docker-based deployment land in PRYs 007–008.

### Run the MCP server (from source)

```bash
node packages/cli/dist/main.js init --admin-email you@example.com   # one-time bootstrap
node packages/cli/dist/main.js serve                                # foreground MCP server
# → Listening on http://127.0.0.1:8443/mcp
```

Endpoints exposed: `POST /mcp` (JSON-RPC + SSE), `GET /mcp` (server-initiated SSE), `DELETE /mcp` (session terminate), `GET /healthz`, `GET /readyz`, `GET /.well-known/jwks.json`. See [`docs/mcp-server.md`](./docs/mcp-server.md) for the full operator guide.

### Administer the Hive

```bash
node packages/cli/dist/main.js hivekeeper create --email teammate@example.com --emit-credential
node packages/cli/dist/main.js agent create --owner you@example.com --name worker-a --type worker --emit-credential
node packages/cli/dist/main.js credential rotate <jti> --yes
node packages/cli/dist/main.js audit query --limit 20
```

Tip: alias `hivectl='node packages/cli/dist/main.js'` in your shell during pre-release. Full operator surface (12 subcommands across `init` / `migrate` / `hive` / `hivekeeper` / `agent` / `credential` / `audit`) documented in [`docs/hivectl.md`](./docs/hivectl.md).

### Distribution status (v0.1)

Hive is **OSS by design** (Apache 2.0). The release pipeline (build matrix + 5-package npm publish under `@hivemine`) ships as part of `v0.1.0`. Until that release is cut, the repo stays private and operators run Hive from source. The build artifact (`hivectl` SEA binary, ~108 MB) is fully self-contained — no Node runtime required at the install host once published. See `_meta/runbooks/release-publish.md` in the vault for the maintainer-facing release procedure.

### Deploy paths

Per ADR-008 the deploy story bifurcates into three topologies:

- **Topology 1 — CLI + SQLite (default OSS adoption path).** `npm install -g @hivemine/hivectl` + `hivectl init` → SQLite at `/var/lib/hive/hive.sqlite` (Linux) or `~/Library/Application Support/Hive/hive.sqlite` (macOS). Zero infra. Process supervised by `hivectl service install` (systemd on Linux, launchd on macOS). Documented in [`packages/cli/README.md`](./packages/cli/README.md) and [`docs/hivectl.md`](./docs/hivectl.md).
- **Topology 1b — CLI + SQLite from source** (contributors / pre-release operators). `pnpm install && pnpm build` + `node packages/cli/dist/main.js init`. Same surface as Topology 1, no install of the published binary.
- **Topology 2 — Docker Compose (production opt-in).** `pnpm install && pnpm build && docker compose -f deployment/docker-compose.yml build && docker compose -f deployment/docker-compose.yml up -d`. Server runs containerized against SQLite-in-volume by default; activate `--profile postgres` to add the bundled Postgres service. Image built locally on the deploy host (no `docker pull` from a registry during Fase 1). Full operator guide in [`deployment/README.md`](./deployment/README.md).

PostgreSQL support ships in v0.1.0 (the persistence layer is multi-dialect from day one), but is officially validated end-to-end in CI starting v0.1.1.

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
