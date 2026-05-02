# Auth + Identity

Hive uses **Ed25519-signed JWTs** ([RFC 8037](https://datatracker.ietf.org/doc/html/rfc8037)) issued by `hivectl` to authenticate Hivekeepers and Agents. There are no passwords, no browser flows, no refresh tokens.

## Quick start

### Bootstrap a new Hive

```bash
hivectl init --admin-email you@example.com
```

This creates the Hive on SQLite (`./var/db/hive.sqlite` by default), generates a fresh signing key, and prints an **admin JWT** to stdout. Save it — that's your `Authorization: Bearer <token>` header for every subsequent admin operation.

To use Postgres instead:

```bash
hivectl init --admin-email you@example.com \
             --db postgres://hive:secret@localhost:5432/hive
```

To customize:

```bash
hivectl init --admin-email you@example.com \
             --hive-name "My Team Hive" \
             --admin-name "Leonardo" \
             --keys-dir ./var/keys \
             --ttl-days 365 \
             --operator-note "initial bootstrap"
```

### Verify and rotate credentials

> **Coming in PRY-007.** `hivectl whoami`, `hivectl credential rotate`, `hivectl credential revoke`, `hivectl agent create` and friends are not yet implemented as CLI surface; the underlying domain is in `@hive/server`.

## Concepts

### Hivekeeper vs Agent

- A **Hivekeeper** is a human operator. Hivekeepers with the `is_admin` flag can create and revoke other participants. The first Hivekeeper is created by `hivectl init` and is automatically admin.
- An **Agent** is an AI participant (Worker or Scout) created by an admin Hivekeeper. Agents receive their own JWTs and operate within the scope of their owner Hivekeeper.

The Hive enforces invariant **"at least one active admin Hivekeeper exists at all times"** — `revokeHivekeeper` operations that would leave the Hive without admins are rejected with `LAST_ADMIN_INVARIANT`.

### Credential lifecycle

| Action     | What happens                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Issue**  | A signed JWT with a unique `jti`, an expiration (`exp`, default 365d), `iss` and `aud` pinned to the Hive, and a snapshot of the participant at issue time. |
| **Rotate** | Atomically issues a new JWT and adds the old `jti` to the revocation blocklist. Use when a credential is suspected leaked, or just to reset the clock.      |
| **Revoke** | Adds a `jti` to the blocklist without issuing a replacement. The credential is rejected on the next verification.                                           |

### What's NOT in v0.1

- Browser flows (OAuth, OpenID Connect)
- Refresh tokens
- Multi-Hive credentials (`iss` / `aud` always pin to a single Hive)
- Multi-tenant key segregation (Hive v0.1 is single-tenant by design — one Hive per deployment, one signing key set per Hive)

## Error codes

When a JWT is rejected by the verifier, you'll see one of:

| Code                         | Meaning                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CREDENTIAL_MISSING`         | No `Authorization: Bearer <token>` header, or the prefix is malformed.                                                                   |
| `CREDENTIAL_INAUTHENTIC`     | Signature, issuer, audience, `kid`, or token shape doesn't match. SubCodes: `signature`, `kid_unknown`, `iss_aud_mismatch`, `malformed`. |
| `CREDENTIAL_EXPIRED`         | The `exp` claim has passed (with a 5s clock tolerance).                                                                                  |
| `CREDENTIAL_NOT_YET_VALID`   | The `nbf` claim is in the future.                                                                                                        |
| `CREDENTIAL_REVOKED`         | The `jti` is on the revocation blocklist (rotated or explicitly revoked).                                                                |
| `PARTICIPANT_NOT_FOUND`      | `sub` does not match any Hivekeeper or Agent. Defense-in-depth — should not occur in normal operation.                                   |
| `PARTICIPANT_NOT_ACTIVE`     | The participant has been suspended (Agents only) or revoked. SubCode is the current state.                                               |
| `INSUFFICIENT_PRIVILEGE`     | The operation requires admin; the caller doesn't have it. SubCodes: `not_admin`, `not_hivekeeper`.                                       |
| `CREDENTIAL_ALREADY_REVOKED` | Operator tried to rotate or revoke a `jti` that is already on the blocklist.                                                             |
| `HIVE_ALREADY_INITIALIZED`   | `hivectl init` invoked against a DB that already has a Hive.                                                                             |

`hivectl` prints the code (and subCode if any) on rejection. Logs include the same fields plus a request id. The raw JWT is **never** logged.

## Configuration

Environment variables consumed at boot:

| Env var              | Default                       | Purpose                                                                                  |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `HIVE_DB_DIALECT`    | `sqlite`                      | Database dialect. `sqlite` or `postgres`. Inferred from `HIVE_DB_URL` prefix if not set. |
| `HIVE_DB_URL`        | `sqlite:./var/db/hive.sqlite` | Connection URL. Prefix `sqlite:` or `postgres://`.                                       |
| `HIVE_DB_POOL_SIZE`  | `10`                          | Postgres-only: connection pool size. Ignored for SQLite.                                 |
| `HIVE_DB_SQLITE_WAL` | `true`                        | SQLite-only: enable WAL journal mode. Set to `false` to disable.                         |
| `HIVE_AUTH_KEYS_DIR` | `./var/keys`                  | Directory for signing key PEMs. Private keys are created with mode `0600`.               |
| `HIVE_LOG_LEVEL`     | `info`                        | Pino logger level.                                                                       |

## See also

- [Root README](../README.md) — stack, repo layout, deploy paths.
- [`@hive/cli` README](../packages/cli/README.md) — CLI surface and exit codes.
- [`@hive/server` README](../packages/server/README.md) — exported APIs of the server package.
