# @hive/cli — `hivectl`

> Admin CLI for Hive operators. Run from the same host as the server, with shell access (the trust anchor for `system` callers).

## Purpose

`hivectl` is the operator's interface for bootstrapping and administering a Hive. It is **not** the user-facing API — agents and clients consume Hive over MCP, not via this CLI.

## Subcommands (Slice 0)

- `hivectl init` — bootstrap a fresh Hive (creates schema, admin Hivekeeper, signing key, prints initial JWT to stdout).

More subcommands land as PRYs close: `agent create`, `agent revoke`, `credential rotate`, `credential revoke`, `hive list-keepers`, `audit query`, etc. — see [PRY-007](https://github.com/hivemine-ai/hive-vault).

## Quick start

```bash
# Local default (SQLite, zero infra)
hivectl init --admin-email you@example.com
# → prints an admin JWT to stdout. Save it.

# Postgres opt-in (production deploys)
hivectl init --admin-email you@example.com \
             --db postgres://hive:secret@localhost:5432/hive
```

See [`docs/auth.md`](../../docs/auth.md) for the full auth flow and error codes.

## Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | success                                                               |
| `1`  | runtime error (DB connection, fs, etc.)                               |
| `2`  | usage error (missing required flag)                                   |
| `3`  | `HIVE_ALREADY_INITIALIZED` (Hive already exists at the configured DB) |

## License

Apache-2.0. See [NOTICE](../../NOTICE).
