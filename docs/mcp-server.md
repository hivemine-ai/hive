# MCP Server

The Hive MCP server exposes the Auth, Cell Store, Visibility, Audit, and Waggle subsystems behind a Model Context Protocol (MCP) Streamable HTTP transport. Client agents speak JSON-RPC over HTTP to call tools and receive push notifications via SSE.

> **Status:** Slice 0 ships in v0.1. Five tools are live; three more (`reply_to`, `list_agents`, `get_agent_status`) land in Slice 1+.

## Quick start

```bash
# 1) Bootstrap a Hive (one-time — creates DB + first Hivekeeper + signing key)
hivectl init

# 2) Start the server
node packages/server/dist/main.js
# → Listening on http://0.0.0.0:8443/mcp
```

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

The server registers 5 tools in v0.1 Slice 0:

| Tool                    | Purpose                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `get_agent_config`      | Returns the calling participant's identity, hive, colony, and capabilities.                               |
| `send_message`          | Sends a message from the caller to a recipient (UUID v7, email, agent reference, or `self`).              |
| `read_mailbox`          | Reads messages from the caller's cell, with optional state / type / sender filters and keyset pagination. |
| `mark_read`             | Marks a batch of message ids as read. Returns `marked` + `ignored` arrays for idempotent client logic.    |
| `check_unread_messages` | Returns the count of delivered (unread) messages and the distinct senders.                                |

Tool inputs are validated against a JSON Schema (derived from zod). Refer to `tools/list` from any MCP client to inspect the live schemas. Tool results are returned as `structuredContent` (preferred) plus a JSON-stringified `text` content fallback.

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

| Variable                                  | Default   | Purpose                                                                                                                                                                                                   |
| ----------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HIVE_MCP_HTTP_HOST`                      | `0.0.0.0` | Bind address. Set `127.0.0.1` for local-only access.                                                                                                                                                      |
| `HIVE_MCP_HTTP_PORT`                      | `8443`    | Listening port.                                                                                                                                                                                           |
| `HIVE_MCP_HTTP_PATH`                      | `/mcp`    | MCP endpoint path.                                                                                                                                                                                        |
| `HIVE_MCP_LOG_LEVEL`                      | `info`    | Pino log level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`.                                                                                                                       |
| `HIVE_MCP_LOG_PRETTY`                     | `false`   | If `true`, use `pino-pretty` (dev only). Production should leave it false (JSON logs).                                                                                                                    |
| `HIVE_MCP_RECHECK_SENDER_STATE`           | `true`    | Toggle the `requireActiveSender` middleware. Disable only in performance-critical deployments where you accept that a revoked sender may make a few tool calls before the next domain check catches them. |
| `HIVE_MCP_READYZ_DB_TIMEOUT_MS`           | `500`     | DB ping timeout for `GET /readyz`.                                                                                                                                                                        |
| `HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS` | `30`      | Max time to drain in-flight requests on SIGTERM/SIGINT.                                                                                                                                                   |
| `HIVE_AUTH_KEYS_DIR`                      | `./keys`  | Where to load the signing keypairs from.                                                                                                                                                                  |

The server also reads the env vars defined by the Auth, Cell Store, Visibility, Audit, and Waggle subsystems. See the per-subsystem docs (in this folder) and tech specs (in the vault) for the full list.

## Error codes

| JSON-RPC code | Meaning                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-32001`      | Authentication required / failed. Bearer missing, invalid, expired, revoked, or session not found.                                               |
| `-32002`      | Forbidden. The participant's role does not allow this operation.                                                                                 |
| `-32004`      | Recipient not reachable. Cell closed, recipient missing, or visibility denied (the wire never distinguishes these reasons — privacy uniformity). |
| `-32602`      | Invalid params. Zod validation failed, or domain-side `INVALID_INPUT`.                                                                           |
| `-32603`      | Internal error. Something unexpected happened — check the server logs.                                                                           |
| `-32601`      | Method not found. The tool name is not in the catalog (e.g. trying to call `reply_to` in v0.1 Slice 0).                                          |

The semantic `subCode` (e.g. `cell_closed_or_missing`, `visibility_denied`) is **never** sent to the client — it lives in the structured logs only.

## See also

- [Auth + Identity](auth.md) — JWT lifecycle, signing keys, error code catalog.
- [`@hive/server` README](../packages/server/README.md) — public API of the underlying domain modules.
- Architecture decisions, tech specs, and product specs live in the [vault](https://github.com/hivemine-ai/hive-vault).
