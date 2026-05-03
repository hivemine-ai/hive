# hivectl — Hive operator CLI

> Bootstrap and administer a Hive from the same host as the server. The operator with shell access is the trust anchor — there is no JWT for `hivectl` itself.

`hivectl` is the OSS admin surface of Hive v0.1. It wraps the same domain layer the MCP server consumes (via `wire.startCli()`), so every CLI command exercises the production code paths. A future admin web UI will reuse those same domain functions.

## Installation

```bash
npm install -g @hivemine/hivectl
```

Self-contained SEA binary (~108 MB) — no Node runtime required at the install host. Per-platform packages cover `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`; the wrapper `@hivemine/hivectl` resolves to the right binary on install via npm `optionalDependencies` filtered by `os` / `cpu`.

Contributors building from source: see [`packages/cli/README.md`](../packages/cli/README.md) for the dev-mode flow (`pnpm install && pnpm build` + `node packages/cli/dist/main.js <args>`).

## Quick start

```bash
# 1. Bootstrap a fresh Hive (one-time). SQLite at ./var/db/hive.sqlite by default.
hivectl init --admin-email you@example.com --output-credential admin.jwt

# 2. Add a teammate Hivekeeper, with a credential.
hivectl hivekeeper create \
  --email teammate@example.com --emit-credential \
  --output-credential teammate.jwt \
  --operator-id you@example.com

# 3. Register an agent under your account, with a credential.
hivectl agent create \
  --owner you@example.com --name worker-a --type worker \
  --emit-credential --output-credential worker-a.jwt \
  --operator-id you@example.com

# 4. List agents owned by you.
hivectl agent list --owner you@example.com

# 5. Rotate a credential (issues new + revokes old). Accepts a UUID v7 JTI
#    or `<participant-ref>:latest` to target the participant's currently-
#    active credential without an intermediate `credential list`.
hivectl credential rotate worker-a@you.cotalker:latest --yes \
  --operator-id you@example.com \
  --output-credential worker-a-rotated.jwt

# 6. Inspect the audit log.
hivectl audit query --limit 20 --operator-id you@example.com

# 7. Revoke an agent (cascade-closes its Cell). Accepts UUID v7 or
#    agent reference (<name>@<owner-local>.<hive>).
hivectl agent revoke worker-a@you.cotalker --yes --operator-id you@example.com
```

`--operator-id` accepts either a Hivekeeper email or a UUID v7 — the email path resolves via DB lookup. UUID is preserved for scripts and tooling.

## Concepts

### `--operator-id` is **attribution**, not authorization

The CLI does not authenticate the operator — shell access to the host is the trust anchor. `--operator-id <email-or-uuid>` lets the operator declare which Hivekeeper they are acting as, so the audit log records `actorKind: 'hivekeeper'` + `actorId: <uuid>`. If the flag is absent, the audit log records `actorKind: 'system'` + `actorId: null` — both are accurate descriptions of what happened.

Two input forms are accepted (per ADR-020):

- **Hivekeeper email** (`me@example.com`) — resolved via DB lookup against the `hivekeepers` table. Best for human operators who remember their own email.
- **UUID v7** (`019de8c4-b3c3-7279-a2ee-09424384da11`) — passed through directly. Best for scripts and tooling that already have the canonical id at hand.

The flag is validated only as a sanity check: the resolved UUID must point to an **active admin** Hivekeeper. If it does not, the CLI exits with `EXIT_PERMISSION (5)`. An attacker with shell access can omit the flag to get `actorKind: 'system'`; the audit log reflects that reality.

Reference syntax accepted across other CLI flags is documented in [ADR-020](https://github.com/hivemine-ai/hive-vault) — agent references (`<name>@<owner-local>.<hive>`) are accepted by `agent revoke <agent-ref>` (PRY-040). The `<participant-ref>:latest` alias is accepted by `credential rotate <jti-or-active-ref>` and `credential revoke <jti-or-active-ref>` (PRY-041 — collapses the `credential list → copy JTI → rotate` flow into a single command). `audit query --actor-id` and `--subject-id` accept Hivekeeper email or agent reference in addition to UUID (PRY-042). With PRY-042 closed, every CLI flag that consumes a participant identifier honours the friendly forms uniformly.

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

### Status snapshot (per ADR-022)

The server (and `hivectl init`) maintains a JSON sidecar at `${XDG_STATE_HOME}/hive/status.json` (default `~/.local/state/hive/status.json` on Linux/Mac). The file holds the current hive name + counts, server runtime info (`bind`, `pid`, `uptimeStartedAt`, `version`) when a server is running, database driver/location/size, and the most recent audit event. Inspect it with:

```
cat ~/.local/state/hive/status.json | jq .
```

The snapshot is **eventually consistent**: the server refreshes it on boot, after every audit event, and on graceful shutdown (clears `server` to `null`). Every `hivectl` command also refreshes the snapshot on exit so a follow-up cold start (`hivectl` no args, planned) sees the latest state without any DB queries. A `SIGKILL`-ed server leaves the snapshot stale — the CLI flags this via `(now - writtenAt) > 2 × heartbeatSeconds` (currently 60 s) instead of mis-reporting "server up".

The schema carries a top-level `v: 1`; future bumps treat older snapshots as missing rather than crashing the reader (forward-compat policy). The file is written atomically (`writeFileSync(.tmp)` + `renameSync`) so a CLI reader can never observe a half-written file.

## Subcommand reference

### `init`

```
hivectl init --admin-email <email> [--admin-display-name <name>]
             [--hive-name <name>] [--db <url>] [--keys-dir <path>]
             [--ttl <duration>] [--output-credential <path>]
```

Bootstrap a fresh Hive: runs migrations, generates a signing key, creates the first Hivekeeper (admin) + their Cell, issues the first credential. Idempotent fail-fast on re-init (returns `EXIT_PRECONDITION`).

`init` auto-creates the parent directories of `--db` (when SQLite — Postgres is skipped), `--keys-dir`, and `--output-credential` if they do not exist, so `hivectl init` can run from any writable cwd without `mkdir -p var/db var/keys` first. Other subcommands (`migrate`, `serve`, etc.) keep the fail-fast behaviour on missing paths.

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
hivectl agent revoke <agent-ref> --yes
```

`create` cascades to a new Cell (cross-domain hook). `revoke` cascades to closing the Agent's Cell.

`<agent-ref>` accepts two input forms (per [ADR-020](https://github.com/hivemine-ai/hive-vault)):

- **Agent reference** — `<name>@<owner-local>.<hive>` (e.g. `worker-a@you.cotalker`). Resolves the owner Hivekeeper by email local-part, then the agent by name under that owner. Best for human operators who just ran `agent create` and remember the name + their own email.
- **UUID v7** — passed through directly (preserves the existing idempotent semantics: revoking an unknown UUID still exits `0`, since opaque ids may correspond to entities the script knows are already revoked). Best for scripts and tooling.

### `credential`

```
hivectl credential issue   --participant-id <email-or-uuid> [--ttl <duration>]
                           [--reason <text>] [--output-credential <path>]
hivectl credential rotate  <jti-or-active-ref> [--ttl <duration>] [--yes]
                           [--output-credential <path>]
hivectl credential revoke  <jti-or-active-ref> [--reason <text>] [--yes]
hivectl credential list    <participant-ref> [--limit N]
```

`<jti-or-active-ref>` (per ADR-020 / PRY-041) accepts:

- **UUID v7 JTI** — passed through directly. Best for scripts and tooling that already have the canonical id at hand.
- **`<participant-ref>:latest`** — alias resolving to the participant's currently-active credential (`revoked_at IS NULL` AND `expires_at > now()`, most-recent by `issued_at`). The inner `<participant-ref>` may be a UUID, a hivekeeper email (`me@example.com:latest`), or an agent reference (`worker-a@you.cotalker:latest`). Resolves the participant first, then looks up the active credential. Errors:
  - Inner participant not found → `EXIT_NOT_FOUND (3)` with subcode `credential_owner_not_found` / `credential_agent_not_found`.
  - Participant exists but has no active credential → `EXIT_NOT_FOUND (3)` with subcode `no_active_credential` (issue a new one with `credential issue`).
  - Reference unparseable → `EXIT_USER_ERROR (1)` with subcode `jti_or_ref_unparseable`.

`list` returns metadata only (jti / kid / dates / isRevoked). The raw JWT is **never** returned by `list`.

### `audit`

```
hivectl audit query [--category <c>...] [--decision <d>]
                    [--actor-id <email-or-agent-ref-or-uuid>]
                    [--subject-id <email-or-agent-ref-or-uuid>]
                    [--from <iso>] [--until <iso>] [--limit N]
```

Limit is capped at 500. Order is `occurred_at DESC, id DESC`.

`--actor-id` and `--subject-id` accept any of (per [ADR-020](https://github.com/hivemine-ai/hive-vault) / PRY-042):

- a UUIDv7 (canonical id, no DB lookup);
- a Hivekeeper email (resolved to its participant id);
- an agent reference `<name>@<owner-local>.<hive>` (resolved via owner local-part + agent name).

The two flags share resolution logic — both reject `self` and the
`<participant-ref>:latest` alias because audit log rows reference participants by
id, not by the active-credential alias. Example:

```bash
hivectl audit query --actor-id you@example.com --limit 20
hivectl audit query --subject-id worker-a@you.cotalker --category cell_close
```

### `serve`

```
hivectl serve [--port N] [--host <addr>] [--log-level <level>] [--log-pretty]
```

Runs the Hive MCP server in the foreground (PRY-031). Blocks until SIGINT/SIGTERM. Logs to stdout/stderr (JSON by default; pretty only with `--log-pretty` or `HIVE_MCP_LOG_PRETTY=true`). Reuses the server `buildWire` directly — no daemonize, no PID file (delegate-to-OS supervision via `service install`).

Bind-address precedence (highest wins): `--host` flag → `HIVE_MCP_HTTP_HOST` env → `<workingDir>/config.json`'s `httpHost` (set by `config network`) → default `127.0.0.1`.

### `service`

```
hivectl service install [--user <name>] [--working-dir <path>] [--bind <local-only|bind-all>]
hivectl service uninstall
hivectl service start
hivectl service stop
hivectl service restart
hivectl service status [--logs N]
```

Single CLI surface for the OS-supervised lifecycle. Per [ADR-019](https://github.com/hivemine-ai/hive-vault) alternative B.2 the OS supervisor (systemd / launchd) owns process supervision; the wrappers exist for UX uniformity:

- `service install` writes the systemd unit (`/etc/systemd/system/hive.service`, requires root) or launchd plist (`~/Library/LaunchAgents/com.hivemine.hivectl.plist`, user-level) pointing at `process.execPath`. Linux installs create the dedicated `hive` system user and chown the working dir (closes [INC-2026-001](https://github.com/hivemine-ai/hive-vault) FLAG-002 — server no longer runs as root). The optional `--bind` flag delegates to `config network` before writing the unit.
- `service uninstall` is idempotent: it stops the service first if active, removes the unit/plist, and reloads the supervisor.
- `service start | stop | restart` are thin wrappers over `systemctl <verb> hive` (Linux) / `launchctl load -w · unload` (Mac). Fire-and-forget — no health-check post-action; use `service status` to verify.
- `service status` parses the OS supervisor output and prints a uniform shape:

  ```
  Service:     hive
  Installed:   yes (systemd | launchd)
  State:       running | stopped | error | not-installed
  PID:         12345        (only if running)
  Uptime:      2h 14m       (only if running; "-" on Mac — launchctl does not expose start time)
  Last log:    <last line>  (only if running)
  ```

  Exit code: `0` if `running`, `1` otherwise (script-friendly: `if hivectl service status > /dev/null; then echo OK; fi`). `--logs N` shows the last N journal/log lines instead of the single last-log line.

Pre-flight checks: `service start | stop | restart | status` fail with a clear `service not installed. Run: hivectl service install` instead of the cryptic OS error when no unit/plist is present.

Windows is not supported as a native service host (`UNSUPPORTED_PLATFORM`). Use Docker per [`deployment/README.md`](../deployment/README.md).

### `config network`

```
hivectl config network <local-only | bind-all>
```

Toggles the persisted bind address consumed by `serve` boot. Writes `<workingDir>/config.json` with `httpHost: "127.0.0.1"` (`local-only`, default) or `"0.0.0.0"` (`bind-all`). On `bind-all` an explicit warning prints to stderr (closes FLAG-005):

```
WARNING: bind-all exposes the MCP server on all network interfaces.
         Without TLS termination via a reverse proxy, JWTs travel in plaintext
         (INC-2026-001 FLAG-005). See deployment/README.md § TLS termination.
```

The setting takes effect on the next `hivectl serve` boot — restart the service after toggling.

## Error codes

| Exit | Constant            | Triggers                                                                                                                                                                         |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `EXIT_OK`           | success                                                                                                                                                                          |
| 1    | `EXIT_USER_ERROR`   | malformed input (`AuthError.INVALID_INPUT`, `CliError.CONFIG_INVALID`), confirm declined                                                                                         |
| 2    | `EXIT_INTERNAL`     | unhandled exception, DB error, fs error                                                                                                                                          |
| 3    | `EXIT_NOT_FOUND`    | `AuthError.PARTICIPANT_NOT_FOUND`, `AuthError.PARTICIPANT_NOT_FOUND_FOR_ISSUE`, `CellError.CELL_NOT_FOUND`                                                                       |
| 4    | `EXIT_PRECONDITION` | `HIVE_ALREADY_INITIALIZED`, `CREDENTIAL_ALREADY_REVOKED`, `INVALID_STATE_TRANSITION`, `LAST_ADMIN_INVARIANT`, `ROOT_REQUIRED`, `WORKING_DIR_PERMISSION`, `SERVICE_NOT_INSTALLED` |
| 5    | `EXIT_PERMISSION`   | `--operator-id` not an active admin (`OPERATOR_ID_NOT_ADMIN`), `INSUFFICIENT_PRIVILEGE`                                                                                          |
| 130  | `EXIT_INTERRUPTED`  | SIGINT / SIGTERM cancelled the operation                                                                                                                                         |

`UNSUPPORTED_PLATFORM` (Windows or other non-Linux/Mac) maps to `EXIT_USER_ERROR` (1).

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

### Pretty logging in the SEA binary

When `hivectl` runs as the SEA binary published under `@hivemine/hivectl-<os>-<arch>`, log output is **always JSON** to stderr — `pino-pretty` is bundled but cannot be loaded as a transport because pino spawns transports in worker threads that need an on-disk path to the transport module. `--log-pretty` and `HIVE_MCP_LOG_PRETTY=true` are silently downgraded to JSON inside the SEA; if either is set explicitly, a one-shot warning is emitted to stderr.

To get human-readable output, pipe stderr through `pino-pretty` from any host that has Node + npx available:

```bash
hivectl serve 2>&1 | npx pino-pretty
```

The non-SEA build (`node packages/cli/dist/main.js`) keeps the auto-pretty-when-non-production behaviour and accepts `--log-pretty` / `HIVE_MCP_LOG_PRETTY=true` normally.

## See also

- [`docs/auth.md`](./auth.md) — JWT semantics, signing keys, credential lifecycle.
- [`docs/mcp-server.md`](./mcp-server.md) — running the MCP server (`hivectl init` is its prerequisite).
- Tech spec [`hivectl + Admin Operations`](https://github.com/hivemine-ai/hive-vault) — internals + decisions.
