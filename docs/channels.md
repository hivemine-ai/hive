# Channels — reactive autonomy for Claude Code agents

Hive emits push notifications via two parallel envelopes ([dual-emit](mcp-server.md#push-notifications-waggle)). The standard envelope (`notifications/resources/updated`) works with every MCP client. The second envelope (`notifications/claude/channel`) is the [Claude Code Channels](https://code.claude.com/docs/en/channels-reference) research-preview path: when enabled, the message content is injected directly into the model's context as a `<channel>` tag, and the model reacts autonomously to incoming mail without polling.

This page is the operator guide for enabling the reactive path in Claude Code clients connecting to a Hive deployment.

> **Status:** Channels is an Anthropic research preview. The wire format and operational gates can change without notice. Hive's Emit 2 path is fail-safe — if Anthropic changes the API, the standard envelope keeps working.

## Quick start

In the working directory where Claude Code's `.mcp.json` points to your Hive server, launch Claude Code with the channels flag:

```bash
cd <working-dir-with-.mcp.json>
claude --dangerously-load-development-channels server:hive
```

Replace `hive` with the server name as it appears in `.mcp.json`. The CLI prints a risk advisory and confirms it is listening:

```
Listening for channel messages from: server:hive
Experimental · inbound messages will be pushed into this session, this carries prompt injection risks.
Restart Claude Code without --dangerously-load-development-channels to disable.
```

Verify the gate registered correctly via the debug log:

```bash
grep -E "Channel notifications" "$(ls -t ~/.claude/debug/*.txt | head -1)" | head -1
```

Expected: `MCP server "hive": Channel notifications registered`. If you see `Channel notifications skipped: ... is not on the approved channels allowlist`, recheck the flag syntax (see [Configuration](#configuration)).

When a Hivekeeper sends the agent a message via `send_message`, the agent's Claude Code session receives a `<channel>` event in its context within ~1–3 seconds and reacts autonomously (typically by invoking `check_unread_messages` and/or `read_mailbox`).

## Concepts

### Reactive autonomy vs polling

Without Channels, an agent has to be told to check for new messages — either by the operator typing in the prompt, or by a wrapper script that periodically calls `check_unread_messages`. With Channels enabled, the model sees the new-mail event in its context as soon as the message arrives and decides to act on it.

This unlocks the "agents collaborate in real time" use case that Hive was built for. Without it, agents are tied to whatever cadence the operator imposes.

### Dual-emit, not channel-only

Hive declares the `experimental: { 'claude/channel': {} }` capability and emits **both** envelopes in parallel on every delivery (per [ADR-011](https://github.com/hivemine-ai/hive-vault) — `02 - Arquitectura/ADRs/ADR-011 - MCP push transport — dual-emit para reactive agents.md`). Standard MCP clients ignore the `claude/channel` notification (unknown method) and rely on `resources/updated` + their own polling. Claude Code clients with the gate enabled get reactive autonomy on top.

This is intentional — Hive does not lock its push semantics to a single vendor. If Anthropic changes the Channels API, the standard envelope keeps working and operators only lose reactive autonomy until Hive's adapter is updated.

### What lands in the model context

Claude Code renders the second envelope as XML inside the model's context window:

```xml
<channel source="hive" cell_id="<UUID v7>" kind="online" unread_count="3" sender_ids="<UUID v7>" waggle_id="<UUID v7>" emitted_at="2026-04-27T12:00:00.000Z">You have 3 unread messages in your mailbox. Run check_unread_messages to read.

<!-- waggle: kind=online, waggle_id=<UUID v7>, emitted_at=2026-04-27T12:00:00.000Z --></channel>
```

- `source="hive"` is auto-derived from the server name in `.mcp.json` — not controllable from Hive's side. Use `meta.cell_id` to discriminate the cell.
- The visible prose is pluralized by `unread_count` (`message` vs `messages`).
- The HTML comment carries traceability metadata (`kind`, `waggle_id`, `emitted_at`) without polluting the prose the model reads.
- The model receives the entire `<channel>...</channel>` block as a system event and decides how to act.

The full wire shape is documented in [`mcp-server.md` — Push notifications (Waggle)](mcp-server.md#push-notifications-waggle).

## Configuration

Three operational gates must be satisfied for Claude Code to route Channels notifications to the model. The first two are well-documented; the third is hidden from `claude --help` (research preview) and is the most common reason a fresh setup silently fails.

### Gate 1 — Claude Code v2.1.80 or later

```bash
claude --version
```

Earlier versions do not register the `claude/channel` notification handler — the server emits the notification, the client drops it without warning.

### Gate 2 — Login with a `claude.ai` account (no API key)

Channels requires authentication via a `claude.ai` account (Pro, Max, or Team/Enterprise SSO). API key auth (`ANTHROPIC_API_KEY` env var) does not activate Channels — the channel registration is gated client-side.

Verify inside a Claude Code session via `/status`. Expected output mentions a `claude.ai` plan (e.g. "Claude Max"), not "API key auth".

### Gate 3 — `--dangerously-load-development-channels server:<name>` flag (per-session)

For MCP servers configured manually in `.mcp.json` (Hive's deployment model), the client requires the `--dangerously-load-development-channels` flag with the server name tagged as `server:<name>`. Without it, the debug log emits `Channel notifications skipped: server <name> is not on the approved channels allowlist`.

```bash
claude --dangerously-load-development-channels server:hive
```

Notes (validated against Claude Code v2.1.119):

- **The flag does not appear in `claude --help`** — it is a research-preview-only flag. The CLI itself prints the exact accepted formats (`plugin:<name>@<marketplace>` for marketplace plugins, `server:<name>` for `.mcp.json`-configured servers) when called with an invalid value.
- **`--channels` and `--dangerously-load-development-channels` are mutually exclusive for the same entry.** `--channels` is for marketplace-plugin allowlists; passing both with the same `server:hive` value leaves the runtime gate failing with "is not on the approved channels allowlist". For `.mcp.json` servers, use **only** the dev-channels flag.
- **The flag is not persisted.** It must be passed on every Claude Code invocation in the working directory. Plain `claude` (no flag) starts a session without channel registration.
- **Multiple servers** can be enabled in a single session: `--dangerously-load-development-channels server:hive server:foo server:bar`.

For Team / Enterprise organizations, additional managed-policy gates may apply (`channelsEnabled` / `allowedChannelPlugins` in managed settings). Personal Pro / Max accounts do not need them. Confirm with your org admin if you hit unexpected `not enabled by org policy` errors.

## Risk advisory — prompt injection

Channels carries an inherent prompt-injection risk that Claude Code itself surfaces at startup:

> _Experimental · inbound messages will be pushed into this session, this carries prompt injection risks._

For Hive specifically: anything a sender writes in `send_message` body lands in the recipient model's context (verbatim, inside the `<channel>` tag's content). A hostile sender registered as a Hivekeeper or Agent can therefore attempt to inject instructions into the recipient model.

**Mitigations Hive provides out of the box:**

- The sender must be authenticated (JWT verified, current state `active`, not revoked).
- The visibility matrix (`canSend`) gates who can message whom — see [Auth + Identity](auth.md) and the visibility tech spec in the vault.
- Every `send_message` is recorded in the audit log with `actorId`, `recipientId`, and a body hash.

**Mitigations Hive does NOT provide today:**

- No content sanitization or filtering of message bodies — Hive delivers the body verbatim by design (preserves fidelity).
- No rate limiting on `send_message` per sender / recipient pair.
- No "trust level" classification — every `active` participant is treated equivalently at the visibility / push layer.

Hive v0.1 is designed for self-hosted deployments where the Hivekeeper controls who registers — the trust assumption is reasonable in that context. Public-facing or untrusted-tenant deployments would need an additional content-filtering layer before the channel inject; that is out of scope for v0.1.

If you need to disable Channels mid-incident, restart Claude Code without the `--dangerously-load-development-channels` flag — the agent reverts to polling Envelope 1 immediately. Hive itself keeps emitting both envelopes; the client opt-in is the gate.

## Troubleshooting

### `Channel notifications skipped: server <name> is not on the approved channels allowlist`

The flag was not parsed correctly. Check that:

- The flag is `--dangerously-load-development-channels`, not `--channels`, for `.mcp.json`-configured servers.
- The value is tagged: `server:hive`, not bare `hive`.
- You are not passing both flags with the same entry — drop `--channels` if present.

### `Channel notifications skipped: server <name> not in --channels list for this session`

You launched Claude Code without any of the channels flags. Add `--dangerously-load-development-channels server:<name>`.

### `Channel notifications skipped: server did not declare claude/channel capability`

The server is not Hive (or is an old Hive build without [PRY-011](https://github.com/hivemine-ai/hive-vault) merged). For Hive, confirm the deploy includes the dual-emit code:

```bash
grep -c "claude/channel" packages/server/dist/transport/mcp/server.js  # → ≥ 1
grep -c "sendChannelNotification\|notifications/claude/channel" packages/server/dist/transport/mcp/subscriber-handle.js  # → ≥ 2
```

If either grep returns 0, rebuild the server (`pnpm -r build`) and restart.

### Server logs show `event=mcp_channel_emit_failed`

Envelope 2 is throwing on the server side. The server caught it and continued — Envelope 1 still delivered (no regression). Inspect the `err.message` field in the structured log to diagnose. Common causes:

- The MCP SDK version pinned in `package.json` does not support `server.notification({ method: 'notifications/claude/channel', ... })` (very old SDK; PRY-011 verified support starts at `@modelcontextprotocol/sdk@^1.29`).
- Socket closed between Envelope 1 and Envelope 2 — transient, recovers on the next delivery.
- Anthropic rejected the namespace mid-flight (research-preview drift) — monitor changelog.

### Worker connects but does not react autonomously

Open the debug log and confirm `Channel notifications registered` is present:

```bash
grep -E "Channel notifications" "$(ls -t ~/.claude/debug/*.txt | head -1)" | head -5
```

If it shows `registered` but the model still does not react, capture a fresh debug log during a `send_message` smoke and inspect inbound notifications:

```bash
grep -E "claude/channel|notifications/" "$(ls -t ~/.claude/debug/*.txt | head -1)" | tail -20
```

If `notifications/claude/channel` arrives at the client but no `<channel>` tag renders into the model's context, the issue is downstream of Hive — likely a Claude Code rendering issue or a research-preview rollout gate beyond the operator's control. File feedback with Anthropic.

## See also

- [MCP Server](mcp-server.md) — endpoint catalog, the 8-tool surface, the Waggle wire format (Envelope 1 + Envelope 2 details).
- [Auth + Identity](auth.md) — JWT lifecycle, signing keys, `hivectl init` bootstrap.
- ADR-011 (dual-emit decision) and the operational runbook for the smoke test live in the [vault](https://github.com/hivemine-ai/hive-vault) under `02 - Arquitectura/ADRs/` and `06 - Iniciativas/Programas/PRG-001 — Hive OSS Fase 1/runbook-channels-smoke-e2e.md`.
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference) — Anthropic's upstream documentation for the feature.
