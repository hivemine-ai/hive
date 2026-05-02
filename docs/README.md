# Hive — Documentation

User-facing documentation for Hive operators and contributors. For project context, the tech stack, and contributing, see the [root README](../README.md).

This directory grows incrementally as PRYs close. Each component gets one user-facing page that focuses on **how to use it from the CLI** (and, in the future, the web UI), not on internal architecture — internals live in the vault tech specs.

## Components

- **[Auth + Identity](auth.md)** — JWT-based authentication, Ed25519 signing keys, `hivectl init` bootstrap, credential lifecycle (issue / rotate / revoke), and the canonical error codes.
- **[MCP Server](mcp-server.md)** — Running the Hive MCP server, environment variables, HTTP endpoints, the full 8-tool catalog, and how to talk to it as an MCP client.
- **[Channels](channels.md)** — Reactive autonomy in Claude Code via the dual-emit push notification path. Operational gates, flag syntax, prompt-injection risk advisory, troubleshooting. Per ADR-011.
- **[hivectl](hivectl.md)** — Operator CLI: bootstrap a Hive, manage Hivekeepers / Agents / credentials, query the audit log, run the server, install OS-supervised service. 10 subcommand groups across `init` / `migrate` / `serve` / `service` / `config` / `hive` / `hivekeeper` / `agent` / `credential` / `audit`.

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
