# hivectl — Hive operator CLI

> Bootstrap and administer a Hive from the same host as the server. The operator with shell access is the trust anchor — there is no JWT for `hivectl` itself.

`hivectl` is the OSS admin surface of Hive v0.1. It wraps the same domain layer the MCP server consumes (via `wire.startCli()`), so every CLI command exercises the production code paths. A future admin web UI will reuse those same domain functions.

## Quick start

```bash
# 1. Bootstrap a fresh Hive (one-time). SQLite at ./var/db/hive.sqlite by default.
hivectl init --admin-email you@example.com --output-credential admin.jwt

# 2. Add a teammate Hivekeeper, with a credential.
hivectl hivekeeper create \
  --email teammate@example.com --emit-credential \
  --output-credential teammate.jwt \
  --operator-id <admin-uuid>

# 3. Register an agent under your account, with a credential.
hivectl agent create \
  --owner you@example.com --name worker-a --type worker \
  --emit-credential --output-credential worker-a.jwt \
  --operator-id <admin-uuid>

# 4. List agents owned by you.
hivectl agent list --owner you@example.com

# 5. Rotate a credential (issues new + revokes old).
hivectl credential rotate <jti> --yes \
  --operator-id <admin-uuid> \
  --output-credential worker-a-rotated.jwt

# 6. Inspect the audit log.
hivectl audit query --limit 20 --operator-id <admin-uuid>

# 7. Revoke an agent (cascade-closes its Cell).
hivectl agent revoke <agent-id> --yes --operator-id <admin-uuid>
```

## Concepts

### `--operator-id` is **attribution**, not authorization

The CLI does not authenticate the operator — shell access to the host is the trust anchor. `--operator-id <uuid>` lets the operator declare which Hivekeeper they are acting as, so the audit log records `actorKind: 'hivekeeper'` + `actorId: <uuid>`. If the flag is absent, the audit log records `actorKind: 'system'` + `actorId: null` — both are accurate descriptions of what happened.

The flag is validated only as a sanity check: the UUID must resolve to an **active admin** Hivekeeper. If it does not, the CLI exits with `EXIT_PERMISSION (5)`. An attacker with shell access can omit the flag to get `actorKind: 'system'`; the audit log reflects that reality.

### Output modes

```
--output table   (default if stdout is a TTY)
--output json    (default if stdout is a pipe; safe for scripts via `jq`)
--output yaml
```

`Date` fields are serialized as ISO 8601 UTC strings in JSON/YAML.

### Confirmation prompts

Destructive commands (`agent revoke`, `credential rotate`, `credential revoke`, `migrate down`) require `--yes`. The TTY interactive prompt path lands in Slice 1+; for now the `--yes` flag is the only way to confirm.

### SQLite default vs Postgres opt-in (per ADR-008)

```
hivectl init                                              # SQLite at ./var/db/hive.sqlite
hivectl init --db sqlite:./path/custom.db                 # SQLite at custom path
hivectl init --db postgres://user:pass@host:port/db       # Postgres opt-in
```

All other subcommands consume the DB via the `HIVE_DB_URL` env var (or the default). They are dialect-agnostic.

## Subcommand reference

### `init`

```
hivectl init --admin-email <email> [--admin-display-name <name>]
             [--hive-name <name>] [--db <url>] [--keys-dir <path>]
             [--ttl <duration>] [--output-credential <path>]
```

Bootstrap a fresh Hive: runs migrations, generates a signing key, creates the first Hivekeeper (admin) + their Cell, issues the first credential. Idempotent fail-fast on re-init (returns `EXIT_PRECONDITION`).

### `migrate`

```
hivectl migrate up        # apply all pending migrations
hivectl migrate down --yes  # roll back the most recent migration (destructive)
hivectl migrate status      # list applied migrations
```

Wraps `Kysely.Migrator` (portable SQLite/PG). `init` runs migrations automatically — only invoke `migrate` directly when you need to inspect or roll back.

### `hive`

```
hivectl hive list-keepers [--active-only] [--limit N]
```

Lists Hivekeepers in the Hive. Read-only — no audit event.

### `hivekeeper`

```
hivectl hivekeeper create --email <email> [--display-name <name>] [--admin]
                          [--emit-credential] [--credential-ttl <duration>]
                          [--output-credential <path>]
```

Creates a Hivekeeper. The Hivekeeper's Cell is created in the same transaction (cross-domain hook). With `--emit-credential`, also issues a credential.

### `agent`

```
hivectl agent create --owner <email-or-uuid> --name <name> --type worker|scout
                     [--capability <cap>...] [--instructions <text>]
                     [--emit-credential] [--credential-ttl <duration>]
                     [--output-credential <path>]
hivectl agent list   [--owner <email-or-uuid>] [--type worker|scout]
                     [--state active|suspended|revoked] [--limit N] [--cursor <c>]
hivectl agent revoke <agent-id> --yes
```

`create` cascades to a new Cell (cross-domain hook). `revoke` cascades to closing the Agent's Cell.

### `credential`

```
hivectl credential issue   --participant-id <email-or-uuid> [--ttl <duration>]
                           [--reason <text>] [--output-credential <path>]
hivectl credential rotate  <jti> [--ttl <duration>] [--yes]
                           [--output-credential <path>]
hivectl credential revoke  <jti> [--reason <text>] [--yes]
hivectl credential list    <participant-ref> [--limit N]
```

`list` returns metadata only (jti / kid / dates / isRevoked). The raw JWT is **never** returned by `list`.

### `audit`

```
hivectl audit query [--category <c>...] [--decision <d>] [--actor-id <uuid>]
                    [--subject-id <uuid>] [--from <iso>] [--until <iso>] [--limit N]
```

Limit is capped at 500. Order is `occurred_at DESC, id DESC`.

## Error codes

| Exit | Constant            | Triggers                                                                                                           |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | `EXIT_OK`           | success                                                                                                            |
| 1    | `EXIT_USER_ERROR`   | malformed input (`AuthError.INVALID_INPUT`, `CliError.CONFIG_INVALID`), confirm declined                           |
| 2    | `EXIT_INTERNAL`     | unhandled exception, DB error, fs error                                                                            |
| 3    | `EXIT_NOT_FOUND`    | `AuthError.PARTICIPANT_NOT_FOUND`, `AuthError.PARTICIPANT_NOT_FOUND_FOR_ISSUE`, `CellError.CELL_NOT_FOUND`         |
| 4    | `EXIT_PRECONDITION` | `HIVE_ALREADY_INITIALIZED`, `CREDENTIAL_ALREADY_REVOKED`, `INVALID_STATE_TRANSITION`, `LAST_ADMIN_INVARIANT`, etc. |
| 5    | `EXIT_PERMISSION`   | `--operator-id` not an active admin (`OPERATOR_ID_NOT_ADMIN`), `INSUFFICIENT_PRIVILEGE`                            |
| 130  | `EXIT_INTERRUPTED`  | SIGINT / SIGTERM cancelled the operation                                                                           |

## Configuration

| Variable                                  | Default                         | Notes                                                             |
| ----------------------------------------- | ------------------------------- | ----------------------------------------------------------------- | ---- | ------ |
| `HIVE_DB_URL`                             | `sqlite:./var/db/hive.sqlite`   | SQLite path or Postgres URL. Override with `--db` on `init`.      |
| `HIVE_DB_DIALECT`                         | inferred from URL               | Force `sqlite` or `postgres` if URL prefix is ambiguous.          |
| `HIVE_AUTH_KEYS_DIR`                      | `./var/keys`                    | Directory for Ed25519 PEMs. Override with `--keys-dir` on `init`. |
| `HIVE_AUTH_CREDENTIAL_DEFAULT_TTL_DAYS`   | `365`                           | Default TTL when `--ttl` is omitted.                              |
| `HIVE_AUTH_SNAPSHOT_MAX_BYTES`            | `16384`                         | Cap on the credential snapshot payload.                           |
| `HIVE_CLI_LOG_LEVEL`                      | `warn`                          | pino log level. Override with `--verbose` for `debug`.            |
| `HIVE_CLI_DEFAULT_OUTPUT`                 | `auto` (table if TTY else json) | Override with `--output table                                     | json | yaml`. |
| `HIVE_CLI_AUDIT_OPERATOR_NOTE_MAX_LENGTH` | `256`                           | Truncates `--operator-note` after this many chars.                |

## See also

- [`docs/auth.md`](./auth.md) — JWT semantics, signing keys, credential lifecycle.
- [`docs/mcp-server.md`](./mcp-server.md) — running the MCP server (`hivectl init` is its prerequisite).
- Tech spec [`hivectl + Admin Operations`](https://github.com/hivemine-ai/hive-vault) — internals + decisions.
