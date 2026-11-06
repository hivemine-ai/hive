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

### Enrollment credentials and Worker tokens (ADR-026)

An **enrollment credential** (`hivectl credential issue --enrollment`) lets sessions register themselves as Worker Agents of its owner. It carries the scope `enroll`, an optional name prefix and an optional cap of active Agents, and grants nothing else: an admin operation presented with it fails with `INSUFFICIENT_PRIVILEGE` (`scoped_credential`). Each registered session gets a short-lived **Worker token** (one hour by default) that it renews before it expires by presenting its last token. The last token keeps working as proof of the holder for `HIVE_HOLDER_PROOF_WINDOW_DAYS` after it expires, so a laptop that slept for a few days resumes without registering again; a newer token, a new registration of the same Agent or a revocation invalidates that proof. Rotating an enrollment stops new registrations but lets registered sessions keep renewing; revoking it also revokes every Worker token issued through it.

**Revocation cleanup.** Every verification reads the revocation table, so the server deletes a row once its credential has expired for longer than the holder-proof window (`exp` plus `HIVE_HOLDER_PROOF_WINDOW_DAYS`, 7 days by default, plus the 5 s clock tolerance): from then on no verification can accept the token, so the row can no longer matter. The purge runs at server start and then every hour, in batches of 1000 rows, and logs `auth_revocations_purged` with the `purged` count and `durationMs` (a failed pass logs `auth_revocations_purge_failed` and retries on the next tick). A revocation of a still-valid credential is never purged. Tune with `HIVE_AUTH_REVOCATION_PURGE_INTERVAL_SECONDS`.

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
| `PARTICIPANT_NOT_ACTIVE`     | The participant has been suspended or retired (Agents only) or revoked. SubCode is the current state.                                    |
| `INSUFFICIENT_PRIVILEGE`     | The operation requires admin; the caller doesn't have it. SubCodes: `not_admin`, `not_hivekeeper`, `scoped_credential`.                  |
| `CREDENTIAL_ALREADY_REVOKED` | Operator tried to rotate or revoke a `jti` that is already on the blocklist.                                                             |
| `HIVE_ALREADY_INITIALIZED`   | `hivectl init` invoked against a DB that already has a Hive.                                                                             |

`hivectl` prints the code (and subCode if any) on rejection. Logs include the same fields plus a request id. The raw JWT is **never** logged.

## Configuration

Environment variables consumed at boot:

| Env var                                       | Default                       | Purpose                                                                                       |
| --------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `HIVE_DB_DIALECT`                             | `sqlite`                      | Database dialect. `sqlite` or `postgres`. Inferred from `HIVE_DB_URL` prefix if not set.      |
| `HIVE_DB_URL`                                 | `sqlite:./var/db/hive.sqlite` | Connection URL. Prefix `sqlite:` or `postgres://`.                                            |
| `HIVE_DB_POOL_SIZE`                           | `10`                          | Postgres-only: connection pool size. Ignored for SQLite.                                      |
| `HIVE_DB_SQLITE_WAL`                          | `true`                        | SQLite-only: enable WAL journal mode. Set to `false` to disable.                              |
| `HIVE_AUTH_KEYS_DIR`                          | `./var/keys`                  | Directory for signing key PEMs. Private keys are created with mode `0600`.                    |
| `HIVE_LOG_LEVEL`                              | `info`                        | Pino logger level.                                                                            |
| `HIVE_AUTH_REVOCATION_PURGE_INTERVAL_SECONDS` | `3600`                        | How often expired revocations are purged. `0` disables the purge (the table then only grows). |
| `HIVE_ENROLLMENT_MAX_AGENTS`                  | `10`                          | Cap of active Agents per enrollment credential, and ceiling of `--max-agents`.                |
| `HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS`         | `90`                          | Default TTL of an enrollment credential. At least `1`.                                        |
| `HIVE_WORKER_TOKEN_TTL_SECONDS`               | `3600`                        | TTL of a Worker token issued at registration. At least `60`.                                  |
| `HIVE_HOLDER_PROOF_WINDOW_DAYS`               | `7`                           | Days after `exp` the last Worker token can still renew. `0` = only valid tokens.              |

## See also

- [Root README](../README.md) — stack, repo layout, deploy paths.
- [`@hive/cli` README](../packages/cli/README.md) — CLI surface and exit codes.
- [`@hive/server` README](../packages/server/README.md) — exported APIs of the server package.
