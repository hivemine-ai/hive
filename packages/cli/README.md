# @hive/cli — `hivectl`

> Admin CLI for Hive operators. Run from the same host as the server, with shell access (the trust anchor for `system` callers per [ADR-007](https://github.com/hivemine-ai/hive-vault)).

## Purpose

`hivectl` is the operator's interface for bootstrapping and administering a Hive. It wraps the same domain layer as the MCP server (via `wire.startCli()`), so every CLI command exercises the same code paths a future admin web UI would. It is **not** the user-facing API — agents and clients consume Hive over MCP, not via this CLI.

What `hivectl` covers (Slice 0):

- `init` — bootstrap a fresh Hive (schema migrations + first admin Hivekeeper + Ed25519 signing key + first credential JWT).
- `migrate up | down | status` — manage schema migrations directly.
- `serve` — run the Hive MCP server in the foreground (PRY-031). Replaces the legacy `node packages/server/dist/main.js` entry point.
- `hive list-keepers` — list Hivekeepers in the Hive.
- `hivekeeper create` — register a new Hivekeeper, optionally with a credential.
- `agent create | list | revoke` — full agent lifecycle (cascade-closes its Cell on revoke).
- `credential issue | rotate | revoke | list` — credential lifecycle.
- `audit query` — read the audit log.

What `hivectl` does **not** cover (deferred to Slice 1+):

- `hivekeeper revoke / set-admin / set-retention`, `hive set-default-retention`, `agent suspend / resume / change-type`, `signing-key rotate`, `audit stream`, `status show`, `maintenance *`. See [PRY-007 vault entry](https://github.com/hivemine-ai/hive-vault).

## Quick start

> During pre-release (Fase 1), `@hive/cli` is **not published to npm**. Run from the build output instead. Tip: alias `hivectl='node packages/cli/dist/main.js'` in your shell.

```bash
# After `pnpm install && pnpm build` from the repo root:

# Local default (SQLite, zero infra)
node packages/cli/dist/main.js init --admin-email you@example.com --output-credential admin.jwt
# → admin.jwt (perms 0600) holds the bootstrap credential

# Common operator workflow (with shell alias)
hivectl hivekeeper create --email teammate@example.com --emit-credential \
  --operator-id <admin-uuid> --output-credential teammate.jwt
hivectl agent create --owner you@example.com --name worker-a --type worker \
  --emit-credential --operator-id <admin-uuid>
hivectl agent list --owner you@example.com
hivectl credential rotate <jti> --yes
hivectl audit query --limit 20

# Postgres opt-in (production deploys)
hivectl init --admin-email you@example.com \
             --db postgres://hive:secret@localhost:5432/hive
```

See [`docs/hivectl.md`](../../docs/hivectl.md) for the full subcommand reference, configuration env vars, and exit codes.

## Public API

The `bin` entry is `hivectl` (compiled to `dist/main.js` with shebang `#!/usr/bin/env node`). The package itself does not expose a programmatic API — programmatic callers should consume `@hive/server` directly (`startCli`, `stopCli`, `CliRuntime`).

## Distribution status

Hive v0.1 stays internal during Fase 1 — the CLI is not published to npm. Operators install by cloning the repo and running `pnpm install && pnpm build`. When v0.1 is battle-tested, a follow-up PRY adds `npm publish` for `@hive/cli` (will install via `pnpm install -g @hive/cli` then).

## Exit codes

| Code  | Constant            | Meaning                                                              |
| ----- | ------------------- | -------------------------------------------------------------------- |
| `0`   | `EXIT_OK`           | success                                                              |
| `1`   | `EXIT_USER_ERROR`   | bad input, malformed args, validation failure, declined confirmation |
| `2`   | `EXIT_INTERNAL`     | unhandled exception, DB connection error, filesystem failure         |
| `3`   | `EXIT_NOT_FOUND`    | Hivekeeper / Agent / Credential / Cell does not exist                |
| `4`   | `EXIT_PRECONDITION` | already revoked, already initialized, last-admin invariant, etc.     |
| `5`   | `EXIT_PERMISSION`   | `--operator-id` provided but resolves to a non-active or non-admin   |
| `130` | `EXIT_INTERRUPTED`  | SIGINT/SIGTERM cancelled the operation                               |

## License

Apache-2.0. See [NOTICE](../../NOTICE).
