# Hive — Documentation

User-facing documentation for Hive operators and contributors. For project context, the tech stack, and contributing, see the [root README](../README.md).

This directory grows incrementally as PRYs close. Each component gets one user-facing page that focuses on **how to use it from the CLI** (and, in the future, the web UI), not on internal architecture — internals live in the vault tech specs.

## Components

- **[Auth + Identity](auth.md)** — JWT-based authentication, Ed25519 signing keys, `hivectl init` bootstrap, credential lifecycle (issue / rotate / revoke), and the canonical error codes.
- **[MCP Server](mcp-server.md)** — Running the Hive MCP server, environment variables, HTTP endpoints, the 5 Slice 0 tools, and how to talk to it as an MCP client.
- **[Channels](channels.md)** — Reactive autonomy in Claude Code via the dual-emit push notification path. Operational gates, flag syntax, prompt-injection risk advisory, troubleshooting. Per ADR-011 (Slice 1).
- **[hivectl](hivectl.md)** — Operator CLI: bootstrap a Hive, manage Hivekeepers / Agents / credentials, query the audit log. 12 subcommands across `init` / `migrate` / `hive` / `hivekeeper` / `agent` / `credential` / `audit`.

## Operator guides

(Full operator guide — install paths, backups, monitoring, upgrades — coming in [PRY-008 — Deployment](https://github.com/hivemine-ai/hive-vault).)

## API reference

The MCP tool catalog (5 tools shipped in v0.1 Slice 0) is documented inline in [`mcp-server.md`](mcp-server.md). The remaining 3 tools (`reply_to`, `list_agents`, `get_agent_status`) land in Slice 1+.

## Architecture & decisions

Architecture decisions live in the vault, not in this repo:

- ADRs: <https://github.com/hivemine-ai/hive-vault> · `02 - Arquitectura/ADRs/`
- Tech specs: same vault · `02 - Arquitectura/Specs Técnicas/`
- Product specs: `03 - Productos/`
