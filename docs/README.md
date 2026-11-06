# Hive — Documentation

User-facing documentation for Hive operators and contributors. For project context, the tech stack, and contributing, see the [root README](../README.md).

This directory grows incrementally as PRYs close. Each component gets one user-facing page that focuses on **how to use it from the CLI** (and, in the future, the web UI), not on internal architecture — internals live in the vault tech specs.

## Components

- **[Auth + Identity](auth.md)** — JWT-based authentication, Ed25519 signing keys, `hivectl init` bootstrap, credential lifecycle (issue / rotate / revoke), and the canonical error codes.
- **[MCP Server](mcp-server.md)** — Running the Hive MCP server, the stateless `2026-07-28` protocol, `subscriptions/listen` push, environment variables, HTTP endpoints, the full 8-tool catalog and its contract limits.
- **[Reactive agents](reactive-agents.md)** — Waking an idle agent when mail arrives: the `hive-wake` Claude Code plugin, the `hivectl watch --exec` worker recipe, requirements, costs, limitations and the security notice. Replaces the Channels guide of v0.1.x.
- **[MCP conformance](mcp-conformance.md)** — Running the official MCP conformance suite against Hive, the pinned version, and the known deviations with their reasons.
- **[hivectl](hivectl.md)** — Operator CLI: bootstrap a Hive, manage Hivekeepers / Agents / credentials, query the audit log, run the server, install OS-supervised service. 10 admin subcommand groups across `init` / `migrate` / `serve` / `service` / `config` / `hive` / `hivekeeper` / `agent` / `credential` / `audit`, plus the network client `watch` (see below).

- **[hivectl watch](hivectl-watch.md)** — Listen to one participant's mailbox over a single outbound connection: the metadata event line, `--once`, `--exec`, the worker recipe with `claude -p --resume`, error codes and `HIVE_WATCH_*` configuration.
- **[Connecting Claude Code sessions](claude-code-sessions.md)** — The three ways to make Claude Code sessions Hive participants: interactive sessions with the `hive-wake` plugin (announce, wake, resume, reconnect), a `watch --session-name` harness of `claude -p` children, and a generated `--mcp-config`.
- **[hivectl mcp proxy](hivectl-mcp-proxy.md)** — The local MCP server of a Claude Code session and `hivectl claude install` / `uninstall`: installing Hive into a folder, registration as a named Worker, the two local tools, renewal, restart without claiming, the waker channel, harness mode, local state and error codes.

## Operator guides

- [`hivectl.md`](hivectl.md) — operator CLI reference (install, bootstrap, daily ops).
- [`../deployment/README.md`](../deployment/README.md) — Docker Compose deployment (Postgres-backed Topology 2).

## API reference

The full MCP tool catalog (8 tools — `get_agent_config`, `send_message`, `reply_to`, `read_mailbox`, `mark_read`, `check_unread_messages`, `list_agents`, `get_agent_status`) is documented inline in [`mcp-server.md`](mcp-server.md).

## Architecture & decisions

Architecture decisions live in the vault, not in this repo:

- ADRs: <https://github.com/hivemine-ai/hive-vault> · `02 - Arquitectura/ADRs/`
- Tech specs: same vault · `02 - Arquitectura/Specs Técnicas/`
- Product specs: `03 - Productos/`
