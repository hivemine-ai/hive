# Hive — Deployment (Docker)

Reference deployment artifacts for running Hive v0.1 OSS in containers.

> **Looking for the no-Docker path?** If you don't need Postgres or container
> isolation, you can run Hive directly with the CLI + SQLite. See
> [`packages/cli/README.md`](../packages/cli/README.md) and
> [`docs/hivectl.md`](../docs/hivectl.md). That path requires only Node 20
> and a process manager (systemd / launchd / pm2). Everything below is for
> Docker users.

This directory ships:

- `Dockerfile` — multi-stage image bundling the server and `hivectl` (single artifact).
- `docker-compose.yml` — reference stack: server default; Postgres opt-in via profile.
- `.env.example` — copy to `.env` to override defaults.
- `.dockerignore` — keeps the build context lean.

## Quick start (SQLite-in-container, default)

The default compose flow runs only the server, against a SQLite database in
the named volume `hive-db`. Zero external infrastructure.

```bash
git clone https://github.com/hivemine-ai/hive
cd hive

# 1. Build the image from source (per ADR-010, no GHCR pull during Fase 1)
pnpm install && pnpm build
docker compose -f deployment/docker-compose.yml build

# 2. Optional: create .env to override defaults (else compose uses built-ins)
cp deployment/.env.example deployment/.env
# edit deployment/.env

# 3. Start the server
docker compose -f deployment/docker-compose.yml up -d hive-server

# 4. Bootstrap a Hivekeeper (one-time). Override the entrypoint to run hivectl:
docker compose -f deployment/docker-compose.yml run --rm \
  --entrypoint hivectl hive-server init \
  --admin-email you@example.com --output-credential -
# → JWT printed to stdout. WRITE THIS DOWN — it is not recoverable.

# 5. Verify
curl -i http://127.0.0.1:8443/healthz             # → 200 OK
curl -i http://127.0.0.1:8443/readyz              # → 200 OK after init
curl -i http://127.0.0.1:8443/.well-known/jwks.json   # → JSON with one key
```

The server listens on `127.0.0.1:8443` of the host by default — secure-by-default
posture. Front it with a TLS-terminating reverse proxy (see
[TLS termination](#tls-termination) below) to expose it publicly.

## Production with Postgres (opt-in)

Activate `--profile postgres` to start the bundled `hive-postgres` service
and switch the server to the Postgres dialect.

```bash
# 1. Set the required password in .env (REQUIRED — postgres image fails fast otherwise)
cat >> deployment/.env <<'EOF'
POSTGRES_PASSWORD=<choose-a-strong-secret>
HIVE_DB_DIALECT=postgres
HIVE_DB_URL=postgres://hive:<same-password>@hive-postgres:5432/hive
EOF

# 2. Bring up both services
docker compose -f deployment/docker-compose.yml --profile postgres up -d

# 3. Apply schema (explicit, NOT auto on boot — see ADR-008)
docker compose -f deployment/docker-compose.yml --profile postgres run --rm \
  --entrypoint hivectl hive-server migrate up

# 4. Bootstrap, same as default flow
docker compose -f deployment/docker-compose.yml --profile postgres run --rm \
  --entrypoint hivectl hive-server init \
  --admin-email you@example.com --output-credential -
```

Pointing at an external Postgres (RDS, Neon, Supabase, on-prem) — set
`HIVE_DB_URL` to the external connection string and skip `--profile postgres`
(the bundled Postgres service is not needed):

```env
HIVE_DB_DIALECT=postgres
HIVE_DB_URL=postgres://USER:PASSWORD@external-host:5432/hive?sslmode=require
```

## Bootstrap (detailed)

The first run of any Hive deployment must:

1. Apply schema migrations.
2. Generate an Ed25519 signing keypair and persist it under `HIVE_AUTH_KEYS_DIR`.
3. Create the first Hivekeeper (admin) and their Cell.
4. Issue the first credential JWT.

`hivectl init` performs all four atomically. It is **not idempotent** — a
second invocation on the same Hive returns `EXIT_PRECONDITION` with
`HIVE_ALREADY_INITIALIZED`. Use `hivectl migrate up` separately if you only
need to roll the schema forward (idempotent).

The JWT is printed to stdout exactly once. The operator MUST capture it.

> ⚠️ **Do not redirect `hivectl init` stdout to a world-readable file.** The
> JWT is a bearer credential. Treat it like a password. If lost, recover by
> rotating the signing key (`hivectl signing-key rotate` — Slice 1+) and
> issuing a new credential.

## Upgrade procedure

Within the same minor (`v0.1.x` → `v0.1.y`), Hive commits to **forward-compatible
schema migrations** (additive only — no DROPs of columns in use). Procedure:

```bash
# 1. Pull the latest source and rebuild the image
git pull
pnpm install && pnpm build
docker compose -f deployment/docker-compose.yml build

# 2. Stop the server gracefully (drains in-flight requests up to
#    HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS, default 30s)
docker compose -f deployment/docker-compose.yml stop hive-server

# 3. Apply new migrations
docker compose -f deployment/docker-compose.yml run --rm \
  --entrypoint hivectl hive-server migrate up

# 4. Restart
docker compose -f deployment/docker-compose.yml up -d hive-server
```

When public distribution opens (PRY-009 follow-up per ADR-010), this becomes
`docker compose pull` instead of `pnpm build && docker compose build` — see
the [Public release path](#public-release-path) note below.

## Backup / restore

**Critical artifacts to preserve:**

1. The DB volume (`hive-postgres-data` for Postgres, `hive-db` for SQLite-in-container).
2. The signing keys volume (`hive-keys`).
3. Optionally `.env` (configuration, not strictly secret).

> ⚠️ **Snapshot consistency.** The DB and the keys must come from the same
> point in time. If the DB references a `kid` that is not in the keys volume
> (or vice versa), every JWT signed against that `kid` fails at verification
> with `kid_unknown`. Backups MUST emit DB and keys as an atomic pair (same
> timestamp suffix). Restores MUST validate the pair before applying.

### Backup (online, no downtime)

For SQLite-in-container:

```bash
# DB snapshot via volume tar (with the server briefly stopped for consistency)
docker compose -f deployment/docker-compose.yml stop hive-server
docker run --rm -v hive-db:/db:ro -v "$(pwd)":/backup alpine \
  tar czf /backup/hive-db-$(date +%Y%m%d-%H%M%S).tgz -C /db .
docker compose -f deployment/docker-compose.yml up -d hive-server
```

For Postgres:

```bash
docker compose -f deployment/docker-compose.yml --profile postgres exec -T hive-postgres \
  pg_dump -U "$POSTGRES_USER" -F c -d "$POSTGRES_DB" \
  > hive-db-$(date +%Y%m%d-%H%M%S).dump
```

Signing keys (read-only, safe online):

```bash
docker run --rm -v hive-keys:/keys:ro -v "$(pwd)":/backup alpine \
  tar czf /backup/hive-keys-$(date +%Y%m%d-%H%M%S).tgz -C /keys .
```

Schedule both nightly via `cron` on the host. Off-site copy via your tool of
choice (`rsync`, `restic`, S3, etc.).

### Restore (clean host)

```bash
# 1. Validate the snapshot pair has matching timestamps
DUMP=hive-db-20260601-020000.tgz
KEYS=hive-keys-20260601-020000.tgz
[[ "${DUMP%.tgz}" != "hive-${KEYS#hive-}" ]] && echo "FATAL: timestamps differ" && exit 1

# 2. Re-create the volumes BEFORE compose creates them empty
docker volume create hive-db
docker volume create hive-keys

# 3. Restore signing keys
docker run --rm -v hive-keys:/keys -v "$(pwd)":/backup alpine \
  tar xzf "/backup/$KEYS" -C /keys

# 4. Restore DB (SQLite path)
docker run --rm -v hive-db:/db -v "$(pwd)":/backup alpine \
  tar xzf "/backup/$DUMP" -C /db

# 5. Bring up the stack
docker compose -f deployment/docker-compose.yml up -d hive-server
```

For Postgres, replace step 4 with `pg_restore` against the bundled service.

## TLS termination

The server speaks plain HTTP on `127.0.0.1:8443` by default. Terminate TLS at
a reverse proxy of your choice. Examples:

**nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name hive.example.com;
    ssl_certificate     /etc/letsencrypt/live/hive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hive.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;       # critical for SSE (MCP notifications)
        proxy_read_timeout 1h;
    }
}
```

**Caddy**

```caddy
hive.example.com {
    reverse_proxy 127.0.0.1:8443 {
        flush_interval -1
    }
}
```

**Traefik (compose label)** — out of scope of this repo; standard
`traefik.http.routers.*` labels apply.

## Logs and observability

The server emits structured JSON logs to stdout via `pino`. Tail them:

```bash
docker compose -f deployment/docker-compose.yml logs -f hive-server
```

Adjust verbosity with `HIVE_MCP_LOG_LEVEL` (default `info`; allowed:
`trace | debug | info | warn | error | fatal`). Set `HIVE_MCP_LOG_PRETTY=true`
for human-readable output (dev only).

**Recommended Docker daemon log rotation** — without rotation the JSON file
driver grows unbounded. Configure in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

JWKS for external auditing is exposed at `/.well-known/jwks.json` (public —
verify-only; no secret material).

Metrics (Prometheus) and distributed tracing are **not yet** in v0.1.

## Troubleshooting

| Symptom                                                                                                                                  | Cause                                                  | Fix                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `docker compose --profile postgres up` exits with `Database is uninitialized and superuser password is not specified` on `hive-postgres` | `POSTGRES_PASSWORD` is empty                           | Set it in `.env`                                                                          |
| `/readyz` returns 503 with `{"event":"keypair_store_no_active_key", ...}`                                                                | Server is up but `hivectl init` was never run          | Run `hivectl init`, then `docker compose restart hive-server`                             |
| `/readyz` returns 503 with `{"event":"db_check_failed", ...}`                                                                            | DB connection failing                                  | Check `docker compose logs hive-postgres` (PG mode) or that the SQLite volume is writable |
| MCP client gets `-32001 Unauthorized` after a restore                                                                                    | JWT references a `kid` no longer in `hive-keys` volume | Rotate signing key and re-issue credentials, OR restore the matching keys snapshot        |
| `docker compose run hive-server hivectl ...` fails with `command not found`                                                              | Image was not rebuilt after recent changes             | `docker compose build`                                                                    |

## Public release path

Hive v0.1 stays internal during Fase 1 per
[ADR-010](https://github.com/hivemine-ai/hive-vault) — the repo is private,
no GHCR pushes, no `npm publish` for `@hive/cli`. Operators build from
source as documented above.

When v0.1 is battle-tested internally, a follow-up PRY (PRY-009) will add:

- `release.yml` workflow to push tagged images to `ghcr.io/hivemine-ai/hive`.
- `npm publish` for `@hive/cli`.
- README update so `docker pull ghcr.io/hivemine-ai/hive:v0.1.x` and
  `pnpm install -g @hive/cli` become the documented quick-start paths.

Until then, treat `git pull && pnpm build && docker compose build` as the
canonical install/upgrade flow.
