# MCP Server

The Hive MCP server exposes the Auth, Cell Store, Visibility, Audit, and Waggle subsystems behind a Model Context Protocol (MCP) Streamable HTTP transport. Client agents speak JSON-RPC over HTTP to call tools and receive push notifications via SSE.

> **Status:** v0.1 ships the full 8-tool catalog — Slice 0 (5 tools) + `reply_to`, `list_agents`, and `get_agent_status` from Slice 2.

## Quick start

```bash
# 1) Bootstrap a Hive (one-time — creates DB + first Hivekeeper + signing key)
hivectl init

# 2) Start the server (foreground, blocks until SIGINT/SIGTERM)
hivectl serve
# → Listening on http://0.0.0.0:8443/mcp
```

Flags: `--port <n>`, `--host <addr>`, `--log-level <trace|debug|info|warn|error|fatal>`, `--log-pretty`. Each flag overrides the matching env var; if omitted, the env var (or its default) is used.

For unattended deployments under systemd / launchd, see `hivectl service install` (PRY-032).

By default the server binds to `0.0.0.0:8443`, exposes `/mcp` for the MCP transport, and reads its signing keys from `./keys/`. All defaults are overridable via environment variables (see [Configuration](#configuration)).

### Smoke check

```bash
curl http://127.0.0.1:8443/healthz
# → {"status":"ok"}

curl http://127.0.0.1:8443/readyz
# → {"status":"ready"}    (or 503 if the DB is unreachable within 500ms)

curl http://127.0.0.1:8443/.well-known/jwks.json
# → {"keys":[{"kty":"OKP","crv":"Ed25519","kid":"...","x":"...","use":"sig","alg":"EdDSA"}]}
```

## Concepts

### Sessions

An MCP session begins when a client sends an `initialize` request. The server generates a session id (UUID v4) and returns it via the `Mcp-Session-Id` response header. Subsequent requests must include `Mcp-Session-Id: <id>` in the request headers.

Each session keeps a verified `IdentityContext` (the Worker / Scout / Hivekeeper that owns the Bearer token) and a Presence subscription. Closing the session (DELETE `/mcp` or socket disconnect) tears both down.

### Authentication

Every request to `/mcp` must carry a Bearer token in the `Authorization` header:

```
Authorization: Bearer <JWT>
```

JWTs are issued by the Auth subsystem (`hivectl init` mints the first admin JWT; `hivectl create-agent --emit-credential` mints worker / scout credentials). The verifier checks the signature, expiry, blocklist, and the participant's current state on every request — a participant revoked mid-session loses access at the next call.

A missing or invalid Bearer returns HTTP 401 with a JSON-RPC error body:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": { "code": -32001, "message": "authentication required" }
}
```

### Tools

The server registers 8 tools in v0.1 (5 from Slice 0 + `reply_to`, `list_agents`, `get_agent_status` from Slice 2):

| Tool                    | Purpose                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_agent_config`      | Returns the calling participant's identity, hive, colony, and capabilities.                                                                                                                                                                                                                                                                                    |
| `send_message`          | Sends a message from the caller to a recipient (UUID v7, email, agent reference, or `self`).                                                                                                                                                                                                                                                                   |
| `reply_to`              | Sends a reply to the original sender of a message in the caller's cell. Recipient is derived from the referenced message; the wire `reply_to` field is propagated to the new message.                                                                                                                                                                          |
| `list_agents`           | Lists agents (workers and scouts) in the hive visible to the caller per the visibility matrix, with optional filters by `type` / `owner` / `capability` and keyset pagination.                                                                                                                                                                                 |
| `get_agent_status`      | Returns the presence (`online` / `offline`) and `last_connected_at` of an agent visible to the caller. Online resolves to `max(sessions)`; offline reads the persisted `agents.last_connected_at` (`null` if never connected). Visibility-denied collapses to `RECIPIENT_UNREACHABLE` for uniform privacy (indistinguishable from a non-existent participant). |
| `read_mailbox`          | Reads messages from the caller's cell, with optional state / type / sender filters and keyset pagination.                                                                                                                                                                                                                                                      |
| `mark_read`             | Marks a batch of message ids as read. Returns `marked` + `ignored` arrays for idempotent client logic.                                                                                                                                                                                                                                                         |
| `check_unread_messages` | Returns the count of delivered (unread) messages and the distinct senders.                                                                                                                                                                                                                                                                                     |

Tool inputs are validated against a JSON Schema (derived from zod). Refer to `tools/list` from any MCP client to inspect the live schemas. Tool results are returned as `structuredContent` (preferred) plus a JSON-stringified `text` content fallback.

#### Recipient reference formats

Tools that accept a recipient (`send_message`, `get_agent_status`) or a sender filter (`read_mailbox.filter.from`) parse the value against four formats, in order:

| Format           | Example                        | Resolves to                                                                                                                                   |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| UUID v7          | `0190abcd-...`                 | The participant whose id matches (no DB lookup beyond format check).                                                                          |
| `self`           | `self`                         | The caller's own participant id.                                                                                                              |
| Hivekeeper email | `admin@example.com`            | The Hivekeeper in the caller's hive whose email matches case-insensitively.                                                                   |
| Agent reference  | `<agent>@<owner-local>.<hive>` | The agent named `<agent>` owned by the Hivekeeper whose email local-part is `<owner-local>`, where `<hive>` matches the caller's `hive.name`. |

**Agent reference grammar (single `@`):** `<agent-name>@<owner-email-local>.<hive-name>` — for example, `worker-test@leonardo.olivares.cotalker` means "the agent `worker-test` owned by the Hivekeeper whose email starts with `leonardo.olivares@…`, in the hive `cotalker`". The trailing `.<hive-name>` is what disambiguates an agent reference from a Hivekeeper email; it must match the caller's hive name. Local-part chars are restricted to `[A-Za-z0-9._-]`.

> **Operator convention.** Pick a `hive.name` that does NOT collide with a real TLD (e.g. avoid `com`, `net`). A Hivekeeper email whose domain happens to end in `.<hive-name>` would otherwise be parsed as an agent reference.

When parsing fails (no `@`, multiple `@`s, or local-part outside the allowed alphabet), the tool returns JSON-RPC `-32602` with `subCode: 'reference_unparseable'`. When parsing succeeds but the lookup finds nothing, it returns JSON-RPC `-32004` with `subCode: 'reference_unresolved'` (privacy-uniform — the wire never distinguishes "not found" from "not visible").

### Push notifications (Waggle)

When a message is delivered to a participant's cell, the server emits **two notifications in parallel** on each delivery — a dual-emit pattern that keeps standard MCP clients working while enabling reactive autonomy in Claude Code. See [Channels](channels.md) for the operator guide on enabling reactive autonomy.

**Envelope 1 — `notifications/resources/updated` (MCP-standard, every client):**

```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "hive://cells/<cellId>",
    "_meta": {
      "hiveWaggle": {
        "kind": "online" | "replay",
        "recipient_id": "<UUID v7>",
        "unread_count": <int>,
        "sender_ids": ["<UUID v7>", ...],
        "emitted_at": "<ISO 8601 UTC>",
        "waggle_id": "<UUID v7>"
      }
    }
  }
}
```

**Envelope 2 — `notifications/claude/channel` (Claude Code Channels — research preview):**

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "You have <N> unread message(s) in your mailbox. Run check_unread_messages to read.\n\n<!-- waggle: kind=<kind>, waggle_id=<UUID v7>, emitted_at=<ISO 8601 UTC> -->",
    "meta": {
      "cell_id": "<UUID v7>",
      "kind": "online" | "replay",
      "unread_count": "<int as string>",
      "sender_ids": "<UUID v7,UUID v7,...>",
      "waggle_id": "<UUID v7>",
      "emitted_at": "<ISO 8601 UTC>"
    }
  }
}
```

Claude Code v2.1.80+ injects `params.content` into the model context wrapped as `<channel source="hive" cell_id="..." ...>...</channel>` (the `meta` entries become XML attributes on the tag), which triggers the model to react autonomously without polling. Standard MCP clients ignore this notification (unknown method) and rely on Envelope 1 plus their own polling. The capability is declared as `experimental: { 'claude/channel': {} }` in the `initialize` response.

**Fail-safe.** Envelope 2 is additive: if `sendNotification` rejects (channel-config drift, socket closed mid-deliver, SDK error), the server logs `event: 'mcp_channel_emit_failed'` and continues — Envelope 1 already delivered and is the load-bearing path. Reactive clients lose autonomy on that delivery; the next Waggle re-attempts cleanly.

**Idempotency.** The `waggle_id` (in either envelope) is internal telemetry — clients **must not** dedup by it. To dedup, re-read state via `read_mailbox` or `check_unread_messages`.

Push notifications travel over the SSE stream the client opened with `GET /mcp`. Clients without an open SSE stream can still poll via the tools above.

### Session lifecycle

Each accepted MCP session registers a presence subscription on the server. Sessions are released by any of: a clean `DELETE /mcp`, a closed SSE stream, server shutdown, **or** the lifecycle hardening described here.

**Cap per participant.** A participant can hold up to `HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT` simultaneous sessions (default `16`). The cap exists because every active session keeps an in-memory entry in the Presence Registry; an unbounded pool would let buggy or malicious clients exhaust memory.

**Idle sweep (TTL passive).** A periodic background sweep evicts sessions whose `lastSeenAt` is older than `HIVE_PRESENCE_IDLE_TIMEOUT_MS` (default `30 min`). The sweep runs every `HIVE_PRESENCE_SWEEP_INTERVAL_MS` (default `5 min`). `lastSeenAt` is refreshed on every successful Waggle delivery to the client, so an SSE-listening client that receives pushes is never evicted just for being passive. Setting `HIVE_PRESENCE_IDLE_TIMEOUT_MS=0` disables the sweep (sessions only freed by explicit close or socket dead — pre-v0.2 behavior).

**LRU at cap-hit.** When a new subscribe would hit the cap, the server checks the oldest session by `lastSeenAt`: if it has been idle for at least `HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS` (default `15 min`), it is evicted and the new session takes its slot; otherwise the new subscribe rejects with the JSON-RPC code `-32602` and a `subCode` of `too_many_sessions`. Setting `HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS=0` disables LRU eviction (cap-hit always rejects).

Both eviction paths emit structured `info` log events for telemetry: `presence_session_evicted_idle` (TTL sweep) and `presence_session_evicted_lru` (cap-hit), each carrying `participantId`, `subscriptionId`, and the relevant timestamps.

### Observability

The server emits structured JSON logs (one event per line) on stdout via [`pino`](https://github.com/pinojs/pino). Operators forward stdout to journald, the docker logs driver, or a sidecar. If no consumer is attached, pino buffers and eventually drops — the server emits a one-shot `stdout_consumer_missing` warn at boot to surface the misconfiguration early.

**Levels.** Per the unified policy:

| Level   | Numeric | When                                                                                              |
| ------- | ------- | ------------------------------------------------------------------------------------------------- |
| `debug` | `20`    | Off by default. Enable with `HIVE_LOG_LEVEL=debug` for tracing. Not part of the normative policy. |
| `info`  | `30`    | Happy-path lifecycle (server, session, request, dispatch, delivery successful).                   |
| `warn`  | `40`    | Recoverable anomalies (auth fail, deprecations, sweep misconfig, visibility deny).                |
| `error` | `50`    | Unrecoverable failure of a specific request — process keeps running.                              |
| `fatal` | `60`    | Process dies (init failure, panic recovery impossible).                                           |

**Request correlation.** Every HTTP request entering the server is tagged with a fresh UUIDv7 `requestId` by the fastify request-id hook. The id propagates through the request-scoped logger, the MCP tool dispatch context, and the audit log row (when the request triggers an audit event), so a single id correlates the full lifecycle of one request across operational logs and the audit table.

Clients can pass their own id via the configured header (default `x-request-id`); the server respects valid UUIDv7 values and discards anything else. The header name is overridable with `HIVE_OBSERVABILITY_REQUEST_ID_HEADER`.

**Redacted paths.** The logger masks bearer tokens, message bodies, and tool call args by default. The redacted paths are: `authorization`, `req.headers.authorization`, `*.authorization`, `*.body`, `*.params.body`, `*.arguments.body`. Components that introduce new sensitive fields can extend the list via `createLogger({ redact: [...] })`.

**Audit log relationship.** Operational logs (this stream) and the audit log (the `audit_log` SQLite/PG table) are separate channels with different retention policies and consumers. The recorder also emits an `audit_recorded` info log line on every successful insert; the row's `request_id` column matches the `requestId` field in that log line, so cross-correlation between the two channels is straightforward (`grep '"event":"audit_recorded"' stdout` ↔ `SELECT request_id FROM audit_log`).

## HTTP endpoints

| Method   | Path                     | Purpose                                                                  |
| -------- | ------------------------ | ------------------------------------------------------------------------ |
| `POST`   | `/mcp`                   | JSON-RPC requests + SSE response stream.                                 |
| `GET`    | `/mcp`                   | Server-initiated SSE stream for notifications.                           |
| `DELETE` | `/mcp`                   | Terminate the session (closes SSE streams, unsubscribes from Presence).  |
| `GET`    | `/healthz`               | Liveness — returns 200 unconditionally.                                  |
| `GET`    | `/readyz`                | Readiness — pings the DB with a 500ms timeout. 200 on ok, 503 otherwise. |
| `GET`    | `/.well-known/jwks.json` | Public signing keys (Ed25519 / EdDSA). CORS open (`*`).                  |

TLS termination is the operator's responsibility — run the server behind nginx, Caddy, or a cloud load balancer. The server itself only speaks plain HTTP.

## Configuration

| Variable                                  | Default        | Purpose                                                                                                                                                                                                   |
| ----------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HIVE_MCP_HTTP_HOST`                      | `0.0.0.0`      | Bind address. Set `127.0.0.1` for local-only access.                                                                                                                                                      |
| `HIVE_MCP_HTTP_PORT`                      | `8443`         | Listening port.                                                                                                                                                                                           |
| `HIVE_MCP_HTTP_PATH`                      | `/mcp`         | MCP endpoint path.                                                                                                                                                                                        |
| `HIVE_LOG_LEVEL`                          | `info`         | Pino log level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. Process-wide. Honored by `main.ts` and the CLI logger when no explicit level is passed.                               |
| `HIVE_MCP_LOG_LEVEL`                      | _unset_        | Legacy override consumed by `main.ts`. Falls back to `HIVE_LOG_LEVEL` when unset. Prefer `HIVE_LOG_LEVEL` in new deploys.                                                                                 |
| `HIVE_MCP_LOG_PRETTY`                     | `false`        | If `true`, use `pino-pretty` (dev only). Production should leave it false (JSON logs).                                                                                                                    |
| `HIVE_OBSERVABILITY_REQUEST_ID_HEADER`    | `x-request-id` | Header from which the server reads an inbound `requestId` for cross-system correlation. The value must be a valid UUIDv7; invalid values are discarded and a fresh id is generated.                       |
| `HIVE_MCP_RECHECK_SENDER_STATE`           | `true`         | Toggle the `requireActiveSender` middleware. Disable only in performance-critical deployments where you accept that a revoked sender may make a few tool calls before the next domain check catches them. |
| `HIVE_MCP_READYZ_DB_TIMEOUT_MS`           | `500`          | DB ping timeout for `GET /readyz`.                                                                                                                                                                        |
| `HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS` | `30`           | Max time to drain in-flight requests on SIGTERM/SIGINT.                                                                                                                                                   |
| `HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE`      | `100`          | Hard cap server-side for `list_agents.pagination.limit`. The zod schema also enforces a `100` literal cap; this env var is the runtime authority and may be set lower.                                    |
| `HIVE_AUTH_KEYS_DIR`                      | `./keys`       | Where to load the signing keypairs from.                                                                                                                                                                  |

### Presence (session lifecycle)

| Variable                                     | Default   | Purpose                                                                                                                                                                     |
| -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT` | `16`      | Cap on simultaneous sessions per participant.                                                                                                                               |
| `HIVE_PRESENCE_IDLE_TIMEOUT_MS`              | `1800000` | Idle threshold (30 min). Sessions whose `lastSeenAt` is older are evicted by the periodic sweep. Set `0` to disable the sweep (pre-v0.2 behavior).                          |
| `HIVE_PRESENCE_SWEEP_INTERVAL_MS`            | `300000`  | Sweep period (5 min). Honored only when `HIVE_PRESENCE_IDLE_TIMEOUT_MS > 0`.                                                                                                |
| `HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS`       | `900000`  | Threshold for LRU eviction at cap-hit (15 min). The oldest session is evicted only if idle for at least this long; otherwise new subscribes reject. Set `0` to disable LRU. |

The server also reads the env vars defined by the Auth, Cell Store, Visibility, Audit, and Waggle subsystems. See the per-subsystem docs (in this folder) and tech specs (in the vault) for the full list.

## Error codes

| JSON-RPC code | Meaning                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-32001`      | Authentication required / failed. Bearer missing, invalid, expired, revoked, or session not found.                                               |
| `-32002`      | Forbidden. The participant's role does not allow this operation.                                                                                 |
| `-32004`      | Recipient not reachable. Cell closed, recipient missing, or visibility denied (the wire never distinguishes these reasons — privacy uniformity). |
| `-32602`      | Invalid params. Zod validation failed, or domain-side `INVALID_INPUT`.                                                                           |
| `-32603`      | Internal error. Something unexpected happened — check the server logs.                                                                           |
| `-32601`      | Method not found. The tool name is not in the catalog (the catalog ships 8 tools in v0.1; unknown names fall here).                              |

The semantic `subCode` (e.g. `cell_closed_or_missing`, `visibility_denied`) is **never** sent to the client — it lives in the structured logs only.

For `-32602` responses originated from input-schema validation (zod), the JSON-RPC error envelope additionally carries a structured `data` field per the JSON-RPC 2.0 spec:

```json
{
  "jsonrpc": "2.0",
  "id": "...",
  "error": {
    "code": -32602,
    "message": "invalid input",
    "data": {
      "issues": [
        { "path": "recipient.email", "code": "invalid_string", "message": "Invalid email" },
        { "path": "body", "code": "too_small", "message": "..." }
      ]
    }
  }
}
```

Each issue carries only `{path, code, message}` — `path` is dot-joined (`"recipient.email"`, `"message_ids.3"`, or `""` for root-level). The value the caller sent (`received` in zod-internals) is **never** echoed (privacy invariant). The `data` field is absent for non-zod paths (auth failures, domain errors with opaque subCodes, etc.). Clients that read only `{code, message}` keep working — `data` is opt-in per spec.

## See also

- [Auth + Identity](auth.md) — JWT lifecycle, signing keys, error code catalog.
- [`@hive/server` README](../packages/server/README.md) — public API of the underlying domain modules.
- Architecture decisions, tech specs, and product specs live in the [vault](https://github.com/hivemine-ai/hive-vault).
