# `hivectl mcp proxy`

A local MCP server, one process per Claude Code session, that registers the session in Hive as a named Worker agent and forwards its tools. Claude Code launches it over stdio through the `hive-wake` plugin; you do not run it by hand. The server side of the contract (`register_session`, the `enroll` scope, renewal) is in [Clients via `hivectl mcp proxy`](./mcp-server.md#clients-via-hivectl-mcp-proxy).

> **Status (v0.3.0 line, in progress).** The proxy itself ships now. The command that installs it into a folder (`hivectl claude install`), the local channel for the waker and the harness mode come next in the same release line.

## Quick start

The proxy resolves the project from `CLAUDE_PROJECT_DIR` (or its working directory) and looks for the enrollment saved for that exact folder under `~/.config/hive/enrollment/`. To try it by hand against a Hive, with a client that speaks MCP over stdio:

```bash
cd ~/notes                      # a folder with an enrollment saved for it
hivectl mcp proxy               # stdin/stdout: MCP; stderr: JSON diagnostics
```

stdout carries only the MCP protocol. Diagnostics go to stderr as JSON lines, never with a token or a credential in them.

## Concepts

**One process, one session.** Claude Code starts one proxy per session and does not relaunch it if it dies; the user recovers with `/mcp` → Reconnect, and the new process registers again by itself (see below).

**Two tools before registration.** Until the session is registered, `tools/list` answers only:

| Tool               | What it does                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register_session` | `name`, `description` (one line, at most 280 characters), optional `capabilities`. Registers the session in Hive. Again with the same name it updates the description; with another name it leaves the previous one (which goes `offline`) first. |
| `session_status`   | Local and read-only, never calls Hive: `registered`, `name`, `agent_ref`, `hive`, `project`, `mode` and `last_error`. Never the token.                                                                                                            |

The answer carries no cache, so Claude Code does not keep the short list. After a successful registration the proxy sends `notifications/tools/list_changed`, and `tools/list` returns Hive's catalog as the server publishes it (without the server's own `register_session`) plus the two local tools. In Claude Code they show as `mcp__plugin_hive-wake_hive__<tool>`, deferred behind ToolSearch.

**Forwarding.** Every other request goes to Hive over Streamable HTTP, revision `2026-07-28`, with the session's Worker token. Towards Claude Code the proxy speaks whatever revision the client offers. A cancelled request (`notifications/cancelled`) aborts the request to Hive; progress, if any, is relayed.

**One listen stream.** Once registered, the proxy keeps the only `subscriptions/listen` stream of the session open on its mailbox, with a [lease](./mcp-server.md#listen-lease). That stream is what makes the agent `online`.

**Renewal.** Worker tokens are short-lived (`HIVE_WORKER_TOKEN_TTL_SECONDS` on the server, 1 hour by default). The proxy renews at half the token life with the last token as Bearer; the stream stays open and the agent stays `online`. If Hive rejects a token (`-32001`), the proxy renews once and, if that is rejected too, registers again with the enrollment credential. Only when that also fails, within a bounded window, does the session become unregistered (`registered: false`, with the reason in `last_error`, and another `list_changed`).

**Restart without claiming.** The last token of each name is kept in `~/.config/hive/state/tokens/<project-key>/<name>.json`, under an exclusive lock that the operating system holds for as long as the process lives (and drops when it dies, even with `kill -9`). A restarted proxy takes the lock and renews with that token instead of claiming the name again. A second session of the same folder that asks for a name another live session holds does not get the lock and receives `name_in_use`.

**Resumed sessions.** On start, and on every `tools/list` while unregistered, the proxy reads the entry its parent `claude` process left in `~/.config/hive/state/pid-map/` (written by the plugin's SessionStart hook). If the start time of the process matches and the entry carries a name, the proxy registers by itself, before the first turn. It publishes its own entry in `~/.config/hive/state/proxies/<claudePid>.json`.

**Ending.** stdin EOF (Claude Code exited, even after `kill -9`), `SIGINT` (`/exit`), `SIGTERM` (end of `claude -p`) and `SIGHUP` close the stream (the agent goes `offline` at once, without waiting for the lease), remove the proxy entry and end the process. Nothing else ends it: when Hive or the network fail, the proxy keeps running, reconnects with backoff and reports the last error in `session_status`.

## Local state

Everything lives under `~/.config/hive/` (or `HIVE_CONFIG_DIR`), never inside the project. Directories are `0700` and files `0600`; a file or directory with laxer permissions is refused (`session_state_insecure_perms`). Writes are atomic.

| Path                                     | Content                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `enrollment/<project-key>.json`          | Hive URL and enrollment credential of one folder (`<project-key>` is a hash of its real path). |
| `state/tokens/<project-key>/<name>.json` | Last Worker token of one name, plus its description; `.lock` beside it.                        |
| `state/pid-map/<claudePid>.json`         | Written by the plugin hook; read by the proxy.                                                 |
| `state/proxies/<claudePid>.json`         | Written by the proxy: handle, socket path, registered, name.                                   |

The lock on `state/tokens/` is an advisory POSIX lock taken through SQLite. It is reliable on local disks; on a home directory mounted over NFS or another network filesystem, locks may not be enforced across machines or may be dropped, so two sessions could both use one name. Keep `HIVE_CONFIG_DIR` on a local disk.

## Error codes

`session_status.last_error.code` and the error of `register_session`:

| Code                           | Meaning                                                                                        | What to do                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `not_installed`                | No enrollment saved for this folder.                                                           | Install Hive in the folder.                       |
| `name_in_use`                  | Another live session holds the name.                                                           | Pick another name.                                |
| `name_taken`                   | An agent created by hand has that name.                                                        | Pick another name.                                |
| `agent_suspended`              | The agent is suspended.                                                                        | Ask the owner or an admin.                        |
| `enrollment_quota_exceeded`    | The enrollment credential reached its agent quota.                                             | Ask the owner.                                    |
| `rate_limited`                 | Too many registrations.                                                                        | Wait and retry.                                   |
| `invalid_input`                | Invalid name, name outside the credential's prefix, or invalid description.                    | Fix the input.                                    |
| `enrollment_rejected`          | Hive rejected the enrollment credential (revoked, or rotated and the folder kept the old one). | Install again with a valid enrollment credential. |
| `description_unknown`          | A resumed session has a name but no description saved.                                         | Call `register_session` with a description.       |
| `protocol_unsupported`         | The server does not serve MCP `2026-07-28`.                                                    | Upgrade the Hive server.                          |
| `server_mismatch`              | The server does not expose tools and resource subscriptions.                                   | Point the folder at a Hive server.                |
| `session_state_insecure_perms` | A state file or directory is readable by others.                                               | `chmod 600` the file, `chmod 700` the directory.  |
| `transport`                    | Hive is unreachable.                                                                           | None: the proxy retries by itself.                |

The proxy never uses exit codes for Hive failures.

## Configuration

| Variable               | Default              | Use                                                                  |
| ---------------------- | -------------------- | -------------------------------------------------------------------- |
| `HIVE_CONFIG_DIR`      | `~/.config/hive`     | Root of the local user state.                                        |
| `HIVE_PROXY_LOG_LEVEL` | `warn`               | `debug`, `info`, `warn`, `error` or `silent` for stderr diagnostics. |
| `CLAUDE_PROJECT_DIR`   | (set by Claude Code) | Project folder; the working directory when absent.                   |

## See also

- [Clients via `hivectl mcp proxy`](./mcp-server.md#clients-via-hivectl-mcp-proxy) — `register_session`, the `enroll` scope and renewal on the server.
- [`hivectl watch`](./hivectl-watch.md) — the stream client the proxy shares its reconnection logic with.
- [Auth + Identity](./auth.md) — enrollment credentials.
