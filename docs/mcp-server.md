# MCP Server

The Hive MCP server exposes the Auth, Cell Store, Visibility, Audit, and Waggle subsystems behind a Model Context Protocol (MCP) HTTP transport. Client agents speak JSON-RPC over HTTP to call tools and receive push notifications over one long-lived stream.

> **Status:** v0.2.2 serves MCP revision `2026-07-28` and nothing else. There is no `initialize` handshake, no session and no legacy fallback. See [Protocol](#protocol) and the breaking changes in the [CHANGELOG](../CHANGELOG.md).

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

### Protocol

Hive serves MCP revision `2026-07-28` only. The revision is stateless: every request stands alone, carries its own protocol version and identity, and the server keeps no per-client state between requests.

**Discovery.** A client calls `server/discover` (not `initialize`) to learn the supported versions, the capabilities and the server info. Claude Code waits 5 seconds for this answer; a server that is slower than that leaves the session without Hive tools.

**Every `POST /mcp` carries:**

| Where                  | Value                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Authorization`        | `Bearer <JWT>`.                                                                                                        |
| `MCP-Protocol-Version` | `2026-07-28`.                                                                                                          |
| `MCP-Method`           | The JSON-RPC method (`tools/call`, `tools/list`, `server/discover`, `subscriptions/listen`, ...).                      |
| `MCP-Name`             | For `tools/call`, the tool name.                                                                                       |
| `Accept`               | `application/json, text/event-stream`.                                                                                 |
| `params._meta`         | `io.modelcontextprotocol/protocolVersion` (`2026-07-28`) and `io.modelcontextprotocol/clientCapabilities` (an object). |

**Capabilities.** `server/discover` advertises exactly `tools` and `resources.subscribe`. Hive does not serve `prompts` and no longer declares `experimental['claude/channel']`. `tools/list` is cacheable (`ttlMs: 60000`, `cacheScope: "public"`); `resources/templates/list` returns the single mailbox template `hive://cells/{cellId}` and is cacheable like `tools/list` (`ttlMs: 60000`, `cacheScope: "public"`); `resources/list` and `resources/read` answer per caller and are never cached (`ttlMs: 0`, `cacheScope: "private"`).

**What is rejected:**

| Request                                                                                           | Answer                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `initialize` without the version header, or under an older version                                | HTTP 400, JSON-RPC `-32022`, with `data.supported` listing `["2026-07-28"]`. |
| `initialize` under the `2026-07-28` header                                                        | HTTP 400, JSON-RPC `-32020`. No session opens.                               |
| A request without the `params._meta` envelope                                                     | HTTP 400, `-32602`.                                                          |
| `GET /mcp`, `DELETE /mcp`                                                                         | HTTP 405. The revision removed both.                                         |
| A request with an `Origin` that is not allow-listed, or a `Host` outside the list when one is set | HTTP 403 (see [Origin and Host](#origin-and-host)).                          |

An `Mcp-Session-Id` header is ignored and the server never issues one. Clients that need `MCP_SDK_GENERATION=v1` or `MCP_PROTOCOL_NEGOTIATION=legacy` cannot talk to Hive: do not set either variable on a Claude Code that connects to a v0.2.0 server. The minimum Claude Code version is the one listed in the [`hive-wake` plugin README](../packages/claude-plugin/README.md#requirements).

Each request is authorized on its own. The verifier checks the signature, expiry, blocklist and the participant's current state on **every** request, so a credential revoked with `hivectl` stops working on the very next request, with no server restart. (In v0.1.x a revocation made from `hivectl` was not applied by the running server until it restarted, INC-2026-008. If you run v0.1.x, restart the server after revoking a credential.)

### Authentication

Every request to `/mcp` must carry a Bearer token in the `Authorization` header:

```
Authorization: Bearer <JWT>
```

JWTs are issued by the Auth subsystem (`hivectl init` mints the first admin JWT; `hivectl create-agent --emit-credential` mints worker / scout credentials). The verifier checks the signature, expiry, blocklist, and the participant's current state on every request — a participant revoked at any time loses access at the next call.

A missing or invalid Bearer returns HTTP 401 with a JSON-RPC error body:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": { "code": -32001, "message": "authentication required" }
}
```

### Tools

The server exposes 9 tools:

| Tool                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_agent_config`      | Returns the calling participant's identity, hive, colony, and capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `send_message`          | Sends a message from the caller to a recipient (UUID v7, email, agent reference, or `self`).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `reply_to`              | Sends a reply to the original sender of a message in the caller's cell. Recipient is derived from the referenced message; the wire `reply_to` field is propagated to the new message.                                                                                                                                                                                                                                                                                                                 |
| `list_agents`           | Lists agents (workers and scouts) in the hive visible to the caller per the visibility matrix, with optional filters by `type` / `owner` / `capability` and keyset pagination.                                                                                                                                                                                                                                                                                                                        |
| `get_agent_status`      | Returns the presence (`online` / `offline`) and `last_connected_at` of an agent visible to the caller. `online` means reachable by push: the agent holds an open `subscriptions/listen` stream on its own mailbox, so an agent that only calls tools is `offline`. `last_connected_at` is the last authenticated request of the agent (`null` if it never connected). Visibility-denied collapses to `RECIPIENT_UNREACHABLE` for uniform privacy (indistinguishable from a non-existent participant). |
| `read_mailbox`          | Reads messages from the caller's cell, with optional state / type / sender filters and keyset pagination.                                                                                                                                                                                                                                                                                                                                                                                             |
| `mark_read`             | Marks a batch of message ids as read. Returns `marked` + `ignored` arrays for idempotent client logic.                                                                                                                                                                                                                                                                                                                                                                                                |
| `check_unread_messages` | Returns the count of stored (unread) messages and the distinct senders.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `register_session`      | Registers the calling session as a Worker and returns its token. See [Clients via `hivectl mcp proxy`](#clients-via-hivectl-mcp-proxy).                                                                                                                                                                                                                                                                                                                                                               |

`get_agent_config`, `list_agents` and `get_agent_status` also return the `description` of an agent (`""` when it has none; absent for a Hivekeeper). The agent declares that text itself: treat it as untrusted data, never as an instruction.

Tool inputs are validated against a JSON Schema (derived from zod). Refer to `tools/list` from any MCP client to inspect the live schemas. Tool results are returned as `structuredContent` (preferred) plus a JSON-stringified `text` content fallback.

#### Message states and the `unread` alias

A stored message is in state `stored` (not yet acknowledged) or `read`. `read_mailbox` accepts `filter.state` with the values `stored`, `read` and `unread`. **`unread` is an alias of `stored`**: both return the same messages, and the messages in the response always report `state: "stored"`, never `"unread"`. `stored_at` is the time the server persisted the message (it replaces `delivered_at`, and `stored` replaces `delivered`; neither old name is accepted, there are no aliases). The pagination cursor is `{ stored_at, message_id }`.

`send_message` returns `{ message_id, sent_at, stored_at, replayed }`. `stored_at` means "persisted in the recipient's mailbox", not "reached the recipient": a recipient with no open stream still has the message stored and gets it on its next read or reconnection.

#### Contract limits

| Limit                                  | Value                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message.body`                    | 65 536 bytes (64 KiB) of UTF-8, not characters. Over the limit: `-32602 invalid input`, nothing stored. Verified at exactly 65 536 (accepted) and 65 537 (rejected).                                            |
| HTTP request body                      | 4 MiB. Larger requests are refused by the HTTP layer with `413` and a non-JSON-RPC body before any tool runs.                                                                                                   |
| `send_message.action` size             | 16 384 bytes of serialized JSON. Over the limit: `-32602`.                                                                                                                                                      |
| `action` nesting depth                 | 32 levels. `send_message` rejects a deeper `action` with `-32602`.                                                                                                                                              |
| `mark_read.message_ids`                | 1 to 200 ids per call. 201 or more: `-32602` with `data.issues[0].message = "mark_read_batch_too_large"`. An empty array is also `-32602`. A malformed id does not fail the batch; it is returned in `ignored`. |
| `read_mailbox.pagination.limit`        | 1 to 100.                                                                                                                                                                                                       |
| `list_agents.pagination.limit`         | 1 to 100 (`HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE` may lower it).                                                                                                                                                   |
| `send_message.ttl_ms`                  | Any positive integer (int64), no maximum. It is stored but **not enforced** in this version: messages are retained indefinitely and never move to `expired`.                                                    |
| Unread messages per sender and mailbox | 500 (`HIVE_CELL_MAX_UNREAD_PER_SENDER`). See [Sender quota](#sender-quota).                                                                                                                                     |

#### `sender_ids` order

`check_unread_messages.sender_ids`, the `mailbox` resource and the `sender_ids` of a push event list each sender once, ordered by the time of that sender's most recent unread message, newest first; senders tied on time are ordered by id. The list includes the caller itself when it has unread messages to itself. The order is stable between calls for the same mailbox state, but it changes as messages arrive and are read: use it as a hint of who wrote last, not as a key.

#### `reply_to` is an advisory hint

`send_message.reply_to` and `type: "response"` are validated for **format only**: the value must be a UUID v7. The server does not check that the referenced message exists, that it is in the caller's mailbox or that the caller may see it, and it does not leak whether an arbitrary id exists. A `response` with no `reply_to` is accepted and stored with `reply_to: null`. Do not treat `reply_to` as proof of threading; clients should verify the thread themselves. The `reply_to` **tool** is different: it takes a message id from the caller's own mailbox, derives the recipient from it and propagates the id.

#### Sender quota

A sender may keep at most `HIVE_CELL_MAX_UNREAD_PER_SENDER` (default `500`) unread messages in one recipient's mailbox. At the limit `send_message` fails with `SENDER_QUOTA_EXCEEDED`, JSON-RPC code `-32005`, and `data: { limit, current }`. The pair stays blocked until the recipient marks messages as read; lowering the limit never deletes anything. The check runs inside the send transaction (on Postgres under an advisory lock), so concurrent sends cannot overshoot the cap. Separately, the **wake** is throttled per sender and mailbox: a sender triggers at most `HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW` push events (default `5`) per `HIVE_WAGGLE_SENDER_WINDOW_MS` (default `60000`); further messages are still stored and one deferred event is sent when the window ends.

#### `last_connected_at`

`get_agent_status.last_connected_at` is refreshed by **any authenticated request** of a Worker or Scout (a tool call, `tools/list`, `server/discover`, opening a stream), not only by opening a stream. To keep a chatty agent from costing one write per call, the refresh is throttled to **one write per agent every 30 seconds**, so the value can lag the real last request by up to 30 s. A failed write is logged (`mcp_last_connected_refresh_failed`) and never fails the request. Hivekeepers do not have the field. Because it is refreshed by tool calls, it says nothing about whether the agent can be reached: use `online` for that.

#### Recipient reference formats

Tools that accept a recipient (`send_message`, `get_agent_status`) or a sender filter (`read_mailbox.filter.from`) parse the value against four formats, in order:

| Format           | Example                        | Resolves to                                                                                                                                   |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| UUID v7          | `0190abcd-...`                 | The participant whose id matches (no DB lookup beyond format check).                                                                          |
| `self`           | `self`                         | The caller's own participant id.                                                                                                              |
| Hivekeeper email | `admin@example.com`            | The Hivekeeper in the caller's hive whose email matches case-insensitively.                                                                   |
| Agent reference  | `<agent>@<owner-local>.<hive>` | The agent named `<agent>` owned by the Hivekeeper whose email local-part is `<owner-local>`, where `<hive>` matches the caller's `hive.name`. |

**Agent reference grammar (single `@`):** `<agent-name>@<owner-email-local>.<hive-name>` — for example, `worker-test@leonardo.olivares.test-hive` means "the agent `worker-test` owned by the Hivekeeper whose email starts with `leonardo.olivares@…`, in the hive `test-hive`". The trailing `.<hive-name>` is what disambiguates an agent reference from a Hivekeeper email; it must match the caller's hive name. Local-part chars are restricted to `[A-Za-z0-9._-]`.

> **Operator convention.** Pick a `hive.name` that does NOT collide with a real TLD (e.g. avoid `com`, `net`). A Hivekeeper email whose domain happens to end in `.<hive-name>` would otherwise be parsed as an agent reference.

When parsing fails (no `@`, multiple `@`s, or local-part outside the allowed alphabet), the tool returns JSON-RPC `-32602` with `subCode: 'reference_unparseable'`. When parsing succeeds but the lookup finds nothing, it returns JSON-RPC `-32004` with `subCode: 'reference_unresolved'` (privacy-uniform — the wire never distinguishes "not found" from "not visible"). The exception is `read_mailbox.filter.from`: an unresolved sender there returns `-32602`.

### Push notifications (Waggle)

Push uses the standard `subscriptions/listen` method of revision `2026-07-28`. A client opens it once, keeps the HTTP response open, and the server writes a frame for every change of its own mailbox. There is a single envelope; Hive no longer sends `notifications/claude/channel`.

**Opening the stream.** `POST /mcp` with `MCP-Method: subscriptions/listen` and

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "subscriptions/listen",
  "params": {
    "notifications": { "resourceSubscriptions": ["hive://cells/<cellId>"] },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The only URI a caller may subscribe to is its own mailbox, the one returned by `resources/list`. Any other URI, or a malformed request, is refused with `-32602` and nothing is registered. A stream with an empty `resourceSubscriptions` is served (it is how Claude Code opens its own stream) but never counts as presence and never receives mailbox events.

**Event.** After the server acknowledges the subscription, each change is a `notifications/resources/updated` frame:

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
        "waggle_id": "<UUID v7>",
        "event_id": "<opaque string>"
      }
    }
  }
}
```

The frame carries metadata only, never a message body. `kind` is `online` for a live event and `replay` for the catch-up sent after the acknowledgment.

- **`event_id`** is deterministic: it derives from the cell, the latest unread message and the unread count, and does not depend on the transport. Two frames that describe the same mailbox state have the same `event_id`, so a client can drop the repeat. Dedup by `event_id`, never by `waggle_id`, which is internal telemetry.
- **Replay.** After **every** acknowledgment (first connection, reconnection, or a client that resumes) the server sends the current unread state if the mailbox has unread messages. A client therefore never needs to query on connect, and a message that arrived while it was disconnected is announced when it comes back. If the replay itself fails, the server closes the stream (reason `replay_failed`) so the client reconnects.
- **At-least-once.** A message that is not marked with `mark_read` is replayed again on every reconnection. Mark what you handled.
- **Coalescing.** Several messages in the quiet window (`HIVE_WAGGLE_QUIET_WINDOW_MS`, default `500`) produce one event with the combined count.

### Stream lifecycle and presence

A participant is `online` exactly while it has at least one open `subscriptions/listen` stream on its own mailbox. There is no idle timer, no sweep and no `lastSeenAt`: a quiet stream stays `online` for as long as the connection is alive. (v0.1.x evicted streams that received no push for 30 minutes, which left a live but quiet worker deaf, INC-2026-007.)

The server sends a keep-alive frame every `HIVE_LISTEN_KEEPALIVE_INTERVAL_MS` (default `15000`) so intermediaries do not close an idle connection and clients can tell a live stream from a dead one. It closes a stream, and the participant stops being `online`, in these cases:

| Cause                                                   | Close reason            | Notes                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client disconnects                                  | _(socket closed)_       | Detected immediately.                                                                                                                                                                              |
| The credential is revoked or the participant is revoked | `participant_revoked`   | Applied within `HIVE_MCP_REVERIFY_INTERVAL_SECONDS` (below).                                                                                                                                       |
| The agent is suspended                                  | `participant_suspended` | Same window.                                                                                                                                                                                       |
| The JWT expires                                         | `credential_expired`    | At the `exp` of the token.                                                                                                                                                                         |
| The participant is over the stream cap                  | `evicted_lru`           | The oldest stream is closed and the new one registers. The cap is `HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT` (default `16`); a new stream is never refused for it. Ends with a `complete` frame. |
| Server shutdown                                         | `shutdown`              | Ends with a `complete` frame.                                                                                                                                                                      |
| The connection stops draining writes                    | `stalled`               | See below.                                                                                                                                                                                         |
| The replay failed                                       | `replay_failed`         | The client reconnects.                                                                                                                                                                             |
| The client asked for a lease and stopped renewing it    | `lease_expired`         | See [Listen lease](#listen-lease). Ends with a `complete` frame.                                                                                                                                   |

**Revocation window.** Credential checks on open streams run in a single periodic pass every `HIVE_MCP_REVERIFY_INTERVAL_SECONDS` (default `60`; `0` disables it and is not for production). A revocation or suspension made with `hivectl` (a different process from the server) therefore closes the stream within that interval, not instantly. New requests are rejected at once. Lower the value if you need a tighter window.

**A silent network cut is detected only for clients that ask for a lease.** The server detects a dead stream when a write fails or when written bytes stop draining for `HIVE_LISTEN_STALL_TIMEOUT_MS` (default `30000`, must stay below `45000`). A silent partition or a stopped client does not trigger either: the kernel keeps accepting the small keep-alive frames. A client that asked for a lease (below) is reported `offline` once the lease runs out, 45 to 60 s after the cut with the defaults. A client without a lease (Claude Code, `hivectl` v0.2.0, any generic MCP client) can keep reporting `online` until the connection finally errors, which on Linux takes on the order of 15 minutes. Either way the client defends itself: `hivectl watch` reconnects after 45 s without any byte (`--silence-timeout`), and a custom client should do the same.

#### Listen lease

A lease is opt-in, outside the MCP wire: two HTTP headers and no change to any method, `_meta` or schema.

1. The client sends `Hive-Listen-Lease: <key>` on the `subscriptions/listen` request. The key is random per connection (`hivectl watch` uses 128 bits, base64url); the server accepts 16 to 128 characters of `A-Z a-z 0-9 _ -` and ignores anything else, as if the header were absent.
2. The server answers the stream with `Hive-Listen-Lease-Ms: <ms>` (`HIVE_LISTEN_LEASE_MS`, default `60000`) and starts the lease.
3. Only if it saw that header, the client renews the lease by sending `server/discover` with the same `Hive-Listen-Lease` header. `hivectl watch` does it every quarter of the lease (15 s with the default), without waiting for the previous answer, so three renewals can be lost before the lease runs out. A client treats a `Hive-Listen-Lease-Ms` outside `400`..`86400000` (the range the server accepts) as no lease. A failed renewal changes nothing on the client.
4. A lease that runs out closes the stream with `lease_expired` (a `complete` frame, then the socket after 1 s), logs `mcp_listen_lease_expired` (warn, with `connectionId`, `participantId` and `leaseMs`), and the participant goes `offline` if that was its last stream.

A key is bound to the authenticated participant that opened the stream: a request from another participant carrying the same key renews nothing. `mcp_listen_opened` logs the granted `leaseMs` (`null` without a lease). A renewal that matches no open leased stream of the caller is logged at debug as `mcp_listen_lease_unmatched` (with `participantId`, never the key).

Compatibility: a listen without the header has no lease and never expires for silence, exactly as in v0.2.0. A server without lease support (v0.2.0) ignores the header and sends no `Hive-Listen-Lease-Ms`, so a newer client sends no renewals. `HIVE_LISTEN_LEASE_MS=0` turns leases off the same way.

Limits:

- A reverse proxy that strips unknown headers disables the lease without an error. `hivectl watch` logs `watch.connected` with `leaseMs: null` in that case.
- Renewals travel on their own HTTP requests. A path that kills only the long stream but lets short requests through keeps the lease alive; the client's silence detector still reconnects.
- A laptop that sleeps longer than the lease goes `offline`. That is intended: a sleeping agent cannot react. On wake-up `watch` reconnects and the replay recovers what arrived meanwhile.
- For clients without a lease, lowering `net.ipv4.tcp_retries2` on the server host (for example to `8`, about 100 s) shortens the time until the kernel gives up. It affects every connection of the host; treat it as an operator choice, not a fix.

**Reactive clients must not poll.** Opening the stream does not wake an idle agent by itself, because MCP gives a server no way to start a turn. See [Reactive agents](reactive-agents.md) for `hivectl watch`, the Claude Code plugin and the worker recipe.

#### Guidelines for custom MCP clients

- **Reconnect with exponential backoff and jitter** after any failure to open `subscriptions/listen` or any dropped stream: for example 1 s, doubling to a cap of 60 s, randomized by up to 50 %, reset after a connection that stayed up for a minute. Do not retry in a tight loop; the log of a v0.1.x client that retried `subscribe` without backoff multiplied the server's noise about five times (INC-2026-001, finding 20).
- Treat a continuous `-32001` as a bad credential, not as a network error: retry for a bounded window, then stop and tell the operator. `hivectl watch` uses 300 s.
- Reconnect after a stretch of silence longer than three keep-alives (45 s with the defaults).
- Use `event_id` to drop repeated events, and call `mark_read` for what you handled.

### Observability

The server emits structured JSON logs (one event per line) on stdout via [`pino`](https://github.com/pinojs/pino). Operators forward stdout to journald, the docker logs driver, or a sidecar. If no consumer is attached, pino buffers and eventually drops — the server emits a one-shot `stdout_consumer_missing` warn at boot to surface the misconfiguration early.

**Levels.** Per the unified policy:

| Level   | Numeric | When                                                                                              |
| ------- | ------- | ------------------------------------------------------------------------------------------------- |
| `debug` | `20`    | Off by default. Enable with `HIVE_LOG_LEVEL=debug` for tracing. Not part of the normative policy. |
| `info`  | `30`    | Happy-path lifecycle (server, stream, request, dispatch, delivery successful).                    |
| `warn`  | `40`    | Recoverable anomalies (auth fail, deprecations, sweep misconfig, visibility deny).                |
| `error` | `50`    | Unrecoverable failure of a specific request — process keeps running.                              |
| `fatal` | `60`    | Process dies (init failure, panic recovery impossible).                                           |

**Request correlation.** Every HTTP request entering the server is tagged with a fresh UUIDv7 `requestId` by the fastify request-id hook. The id propagates through the request-scoped logger, the MCP tool dispatch context, and the audit log row (when the request triggers an audit event), so a single id correlates the full lifecycle of one request across operational logs and the audit table.

Clients can pass their own id via the configured header (default `x-request-id`); the server respects valid UUIDv7 values and discards anything else. The header name is overridable with `HIVE_OBSERVABILITY_REQUEST_ID_HEADER`.

**Redacted paths.** The logger masks bearer tokens, message bodies, and tool call args by default. The redacted paths are: `authorization`, `req.headers.authorization`, `*.authorization`, `*.body`, `*.params.body`, `*.arguments.body`. Components that introduce new sensitive fields can extend the list via `createLogger({ redact: [...] })`.

**Audit log relationship.** Operational logs (this stream) and the audit log (the `audit_log` SQLite/PG table) are separate channels with different retention policies and consumers. The recorder also emits an `audit_recorded` info log line on every successful insert; the row's `request_id` column matches the `requestId` field in that log line, so cross-correlation between the two channels is straightforward (`grep '"event":"audit_recorded"' stdout` ↔ `SELECT request_id FROM audit_log`).

## Clients via `hivectl mcp proxy`

**Why a proxy.** A Claude Code session reaches Hive through a local process, `hivectl mcp proxy`, instead of a Worker credential written into its configuration. Claude Code talks to the proxy over stdio; the proxy talks to Hive over Streamable HTTP, revision `2026-07-28`. The proxy holds an **enrollment credential** of its owner (a Hivekeeper), registers the session as a Worker with `register_session`, and from then on calls every tool with the Worker token it got back.

**`register_session`.** Input: `name` (an agent name, `[a-z][a-z0-9-]*`), `description` (one line, 1 to 280 characters, no control characters) and optional `capabilities` (array of strings). Output: `{ agent_ref, agent_id, token, expires_at }`, where `agent_ref` is `<name>@<owner-local>.<hive>` and `token` is the Worker token (a secret: the server never logs it and marks the response `Cache-Control: no-store`). Called with the enrollment credential, it:

- **creates** the agent when the owner has none with that name;
- **claims** it when an agent of the owner with that name exists and nobody holds it (no open listen stream). A claim replaces every earlier token of the agent: they answer `-32001` from then on.

Called with the **last Worker token of the agent as Bearer** (not the enrollment credential), it **renews** the token and updates `description` and `capabilities`. The last token is accepted even expired, up to `HIVE_HOLDER_PROOF_WINDOW_DAYS` (7) after its `exp`; past that, or when it is no longer the last token issued, the renewal answers `-32001` and the client registers again with the enrollment credential. A renewal does not invalidate the previous token (it works as a Bearer until its `exp`, but no longer as a renewal proof), and the open listen stream of the agent moves to the new token: it does not close at the old `exp` and the agent stays `online`.

| Code     | HTTP | Meaning                                                                                                                                                                             | What to do                                   |
| -------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `-32007` | 200  | Name in use: another session holds it (open listen stream), claims it right now, or just created it and has not opened its stream yet (up to `HIVE_PRESENCE_CLAIM_RESERVATION_MS`). | Pick another name, or retry once it is free. |
| `-32008` | 200  | Name taken by an agent created by hand (or a Scout); never claimable through enrollment.                                                                                            | Pick another name.                           |
| `-32009` | 200  | The agent is suspended.                                                                                                                                                             | Ask the owner or an admin to resume it.      |
| `-32010` | 200  | The enrollment credential reached its agent quota. `data: { limit }`.                                                                                                               | Ask the owner.                               |
| `-32011` | 429  | Too many registrations for this credential (or this agent, on a renewal). `Retry-After` is set.                                                                                     | Wait `Retry-After` seconds.                  |
| `-32602` | 200  | Invalid name, name outside the credential's prefix, invalid description, or a renewal with another name.                                                                            | Fix the input.                               |
| `-32001` | 401  | Holder proof rejected (renewal), or the credential is revoked.                                                                                                                      | Register with the enrollment credential.     |
| `-32006` | 403  | The enrollment credential was used for something other than `register_session` or `server/discover`.                                                                                | Use the Worker token.                        |

**The `enroll` scope.** An enrollment credential is accepted only by `tools/call register_session` and `server/discover` (which the proxy calls to detect a version skew). `tools/list`, any other tool, `resources/*` and `subscriptions/listen` answer HTTP 403 with `-32006` `"credential out of scope"`: a client that lists tools with the enrollment credential sees that error, not an empty catalog. `tools/list` with a Worker token returns the 9 tools; the server never publishes a tool named `session_status` (the proxy defines it).

**Rate limit and alerts.** `register_session` allows `HIVE_ENROLLMENT_REGISTER_RATE_LIMIT` (30) calls per `HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS` (60) per enrollment credential, or per agent on a renewal. `HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD` (5) rejections of one name within `HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES` (10) record an `enrollment_reject_alert` audit event and leave one notice in the owner's mailbox; each newly created agent leaves one too. These notices come from the Hive itself: `read_mailbox` shows them with `from: "system"` and `from_kind: "system"`, `check_unread_messages` and push events list the sender as `system`, and `reply_to` to one answers `-32004`. All these counters live in memory and reset on restart.

**Retired agents.** `list_agents` does not return retired agents yet; the retirement of idle session agents, their revival and the `include_retired` filter arrive in a later release of the v0.3.0 line.

**Tool names in Claude Code.** Through the plugin, Claude Code names the Hive tools `mcp__plugin_hive-wake_hive__<tool>` and defers them behind ToolSearch: the model loads a tool by name before its first call.

**Your own MCP client with an enrollment credential.** A client that registers but never opens a `subscriptions/listen` stream on its own mailbox shows as `offline`, and another session with the same enrollment credential can claim its name (taking over the agent and invalidating its token). Keep a listen stream open, ideally with a [lease](#listen-lease), for as long as the session should own the name.

## HTTP endpoints

| Method   | Path                     | Purpose                                                                                                                  |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/mcp`                   | The only MCP entry: every JSON-RPC request, including `subscriptions/listen`, whose response is a long-lived SSE stream. |
| `GET`    | `/mcp`                   | `405`. The revision removed the standalone notification stream.                                                          |
| `DELETE` | `/mcp`                   | `405`. There are no sessions to terminate.                                                                               |
| `GET`    | `/healthz`               | Liveness — returns 200 unconditionally.                                                                                  |
| `GET`    | `/readyz`                | Readiness — pings the DB with a 500ms timeout. 200 on ok, 503 otherwise.                                                 |
| `GET`    | `/.well-known/jwks.json` | Public signing keys (Ed25519 / EdDSA). CORS open (`*`).                                                                  |

TLS termination is the operator's responsibility — run the server behind nginx, Caddy, or a cloud load balancer. The server itself only speaks plain HTTP.

### Origin and Host

The revision requires the server to validate `Origin`, as a defense against DNS rebinding on a loopback bind. Hive checks it before the Bearer token:

- `HIVE_MCP_ALLOWED_ORIGINS` (comma-separated, default empty): an allow-list of `Origin` values. A request with **no** `Origin` header (every non-browser client, including Claude Code, `hivectl watch` and `curl`) always passes; a request with an `Origin` that is not on the list gets HTTP 403. With the default, no browser origin is allowed.
- `HIVE_MCP_ALLOWED_HOSTS` (comma-separated, default empty): an allow-list of `Host` values, compared case-insensitively. Empty means `Host` is not validated, so a request with any `Host` (including a DNS-rebinding attempt) is accepted; the server logs a one-time `allowed_hosts_empty` warning at startup in that case. Set it to the public name of your deployment (for example `hive.example.com`) if you want requests for any other `Host` refused.

## Configuration

| Variable                                  | Default        | Purpose                                                                                                                                                                             |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HIVE_MCP_HTTP_HOST`                      | `0.0.0.0`      | Bind address. Set `127.0.0.1` for local-only access.                                                                                                                                |
| `HIVE_MCP_HTTP_PORT`                      | `8443`         | Listening port.                                                                                                                                                                     |
| `HIVE_MCP_HTTP_PATH`                      | `/mcp`         | MCP endpoint path.                                                                                                                                                                  |
| `HIVE_LOG_LEVEL`                          | `info`         | Pino log level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. Process-wide. Honored by `main.ts` and the CLI logger when no explicit level is passed.         |
| `HIVE_MCP_LOG_LEVEL`                      | _unset_        | Legacy override consumed by `main.ts`. Falls back to `HIVE_LOG_LEVEL` when unset. Prefer `HIVE_LOG_LEVEL` in new deploys.                                                           |
| `HIVE_MCP_LOG_PRETTY`                     | `false`        | If `true`, use `pino-pretty` (dev only). Production should leave it false (JSON logs).                                                                                              |
| `HIVE_OBSERVABILITY_REQUEST_ID_HEADER`    | `x-request-id` | Header from which the server reads an inbound `requestId` for cross-system correlation. The value must be a valid UUIDv7; invalid values are discarded and a fresh id is generated. |
| `HIVE_MCP_READYZ_DB_TIMEOUT_MS`           | `500`          | DB ping timeout for `GET /readyz`.                                                                                                                                                  |
| `HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS` | `30`           | Max time to drain in-flight requests on SIGTERM/SIGINT.                                                                                                                             |
| `HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE`      | `100`          | Hard cap server-side for `list_agents.pagination.limit`. The zod schema also enforces a `100` literal cap; this env var is the runtime authority and may be set lower.              |
| `HIVE_AUTH_KEYS_DIR`                      | `./var/keys`   | Where to load the signing keypairs from.                                                                                                                                            |

### Network edge, streams and push

| Variable                                       | Default | Purpose                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HIVE_MCP_ALLOWED_ORIGINS`                     | _empty_ | Comma-separated allow-list of `Origin` values. Empty: only clients that send no `Origin` pass. See [Origin and Host](#origin-and-host).                                                                                                                                              |
| `HIVE_MCP_ALLOWED_HOSTS`                       | _empty_ | Comma-separated allow-list of `Host` values. Empty: `Host` is not validated.                                                                                                                                                                                                         |
| `HIVE_MCP_REVERIFY_INTERVAL_SECONDS`           | `60`    | How often open streams are re-checked against the current credential and participant state. This is the maximum time a revoked or suspended participant keeps a stream. `0` disables the check (not for production).                                                                 |
| `HIVE_LISTEN_KEEPALIVE_INTERVAL_MS`            | `15000` | Keep-alive frame period on every `subscriptions/listen` stream. Must be below `45000`, the silence after which `hivectl watch` reconnects. Provisional.                                                                                                                              |
| `HIVE_LISTEN_STALL_TIMEOUT_MS`                 | `30000` | A stream whose written bytes do not drain for this long is closed (`stalled`). Must be below `45000`, the silence after which `hivectl watch` reconnects; the server refuses to start otherwise. Provisional.                                                                        |
| `HIVE_LISTEN_LEASE_MS`                         | `60000` | Lease granted to a `subscriptions/listen` that asks for one (see [Listen lease](#listen-lease)). `0` turns leases off; otherwise between `400` and `86400000` and above `HIVE_LISTEN_KEEPALIVE_INTERVAL_MS`, or the server refuses to start. Streams without a lease are unaffected. |
| `HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT`   | `16`    | Cap on simultaneous listen streams per participant (the name is kept from v0.1). At the cap the oldest stream is closed and the new one registers. A presence entry has no other timeout: it lives as long as its stream.                                                            |
| `HIVE_WAGGLE_QUIET_WINDOW_MS`                  | `500`   | Quiet window that coalesces several messages into one event.                                                                                                                                                                                                                         |
| `HIVE_WAGGLE_REPLAY_DELAY_MS`                  | `0`     | Delay before the replay that follows an acknowledgment.                                                                                                                                                                                                                              |
| `HIVE_WAGGLE_SENDER_WAKEUPS_PER_WINDOW`        | `5`     | Push events one sender can trigger in one mailbox per window. Further messages are stored and one deferred event is sent at the end of the window. Provisional.                                                                                                                      |
| `HIVE_WAGGLE_SENDER_WINDOW_MS`                 | `60000` | The window of the throttle above. Must not be lower than `HIVE_WAGGLE_QUIET_WINDOW_MS`. Provisional.                                                                                                                                                                                 |
| `HIVE_PRESENCE_CLAIM_RESERVATION_MS`           | `10000` | How long a `register_session` claim keeps the name reserved until the claimant opens its listen stream. Expired without a stream, the name is claimable again. Provisional.                                                                                                          |
| `HIVE_ENROLLMENT_REGISTER_RATE_LIMIT`          | `30`    | `register_session` calls per window per enrollment credential (or per agent on a renewal). Beyond it: HTTP 429, `-32011`. `0` disables it.                                                                                                                                           |
| `HIVE_ENROLLMENT_REGISTER_RATE_WINDOW_SECONDS` | `60`    | The window of the limit above.                                                                                                                                                                                                                                                       |
| `HIVE_ENROLLMENT_REJECT_ALERT_THRESHOLD`       | `5`     | Rejections of one name by `register_session` that alert the owner (audit event and mailbox notice). `0` disables the alert.                                                                                                                                                          |
| `HIVE_ENROLLMENT_REJECT_ALERT_WINDOW_MINUTES`  | `10`    | The window of the alert above; one alert per window and name.                                                                                                                                                                                                                        |
| `HIVE_CELL_MAX_UNREAD_PER_SENDER`              | `500`   | Unread messages one sender may keep in one mailbox; beyond it `send_message` fails with `SENDER_QUOTA_EXCEEDED` (`-32005`). Provisional.                                                                                                                                             |

**Removed in v0.2.0.** `HIVE_PRESENCE_IDLE_TIMEOUT_MS`, `HIVE_PRESENCE_SWEEP_INTERVAL_MS`, `HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS` and `HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS` no longer exist: there is no idle sweep. A value set in your environment is ignored without an error, so remove it from your unit files and `.env`.

The server also reads the env vars defined by the Auth, Cell Store, Visibility, Audit, and Waggle subsystems. See the per-subsystem docs (in this folder) and tech specs (in the vault) for the full list.

## Error codes

| JSON-RPC code        | Meaning                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32001`             | Authentication required / failed. Bearer missing, invalid, expired, revoked, or the participant is not active. HTTP 401.                                                                                                                                              |
| `-32004`             | Recipient not reachable. Cell closed, recipient missing, or visibility denied (the wire never distinguishes these reasons — privacy uniformity).                                                                                                                      |
| `-32005`             | `SENDER_QUOTA_EXCEEDED`. The sender has too many unread messages in this recipient's mailbox. `data: { limit, current }`.                                                                                                                                             |
| `-32006`             | Forbidden (`INSUFFICIENT_PRIVILEGE`). The participant's role does not allow this operation. **Was `-32002` in v0.1.x.** An enrollment credential used for anything but `register_session` or `server/discover` gets it with HTTP 403 and `"credential out of scope"`. |
| `-32007` to `-32011` | `register_session` only: name in use, name taken, agent suspended, enrollment quota exceeded (`data: { limit }`), too many registrations (HTTP 429, `Retry-After`). See [Clients via `hivectl mcp proxy`](#clients-via-hivectl-mcp-proxy).                            |
| `-32602`             | Invalid params. Zod validation failed, domain-side `INVALID_INPUT`, an unknown tool name, or a `subscriptions/listen` for a URI that is not the caller's mailbox.                                                                                                     |
| `-32603`             | Internal error. Something unexpected happened — check the server logs.                                                                                                                                                                                                |
| `-32020`             | `initialize` is rejected under the `2026-07-28` header. HTTP 400.                                                                                                                                                                                                     |
| `-32022`             | Unsupported protocol version or no version. HTTP 400, with `data.supported`.                                                                                                                                                                                          |

`-32002` is not used: the SDK rewrites it to `-32602` on the wire because the revision retired it as "resource not found", so Hive moved forbidden to `-32006`. An **unknown tool** now answers `-32602`; it was `-32601` in v0.1.x.

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
