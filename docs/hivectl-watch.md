# `hivectl watch`

`hivectl watch` listens to the mailbox of **one participant** (an Agent or a Hivekeeper) over a single outbound connection and prints a line of metadata for every event. It is how an idle agent finds out that something arrived: the MCP standard does not let a server start a turn on its own, so something local has to hold the connection and react.

`watch` is deliberately thin. It never reads a message body, never calls `read_mailbox`, never writes to the mailbox and keeps nothing on disk. The mailbox on the server is the source of truth.

## Quick start

```bash
# 1. Issue a dedicated credential for the agent (on the Hive host) and copy it to the agent's machine.
hivectl credential issue --participant-id <agent-id> --ttl 30d --output-credential agent.jwt --operator-id you@example.com

# 2. On the agent's machine: the file must be mode 0600 in a folder that is mode 0700.
install -d -m 700 ~/.config/hivectl && install -m 600 agent.jwt ~/.config/hivectl/credential

# 3. Watch. One JSON line per event on stdout; diagnostics on stderr.
hivectl watch --server https://hive.example.com/mcp
# {"eventId":"evt-8f2","senders":["0198f1..."],"count":2}
```

While the connection is open the participant counts as `online` (reachable by push). If `watch` stops, the participant goes `offline` even if it keeps calling tools.

## The event line

Exactly three fields, on a single line:

| Field     | Meaning                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `eventId` | Opaque id. `check:<UUID>` when the line comes from a query (`--once`, or the re-check after `--exec`); unique per line. |
| `senders` | Opaque references to the senders with unread messages. Not emails, not names.                                           |
| `count`   | Unread messages in the mailbox at the time of the event.                                                                |

There is no type, no subject and no body. Fields that arrive with an invalid shape are dropped and reported on stderr. Consumers must ignore unknown fields: new ones are only ever added.

A replay after a reconnection produces the same line as a live event; `watch` does not tell them apart.

## Connection behaviour

- **No query on connect.** After every (re)connection the server replays what is unread; `watch` treats the replay like any other event.
- **Reconnection with backoff** after any cut, with a silence detector: no bytes for `--silence-timeout` seconds (default 45, three missed keep-alives) forces a reconnect. A server that is down never makes `watch` exit.
- **Listen lease.** Every connection asks the server for a lease (`Hive-Listen-Lease`). If the server grants one (v0.2.1 or later, see [Listen lease](mcp-server.md#listen-lease)), `watch` renews it with `server/discover` every quarter of the lease (15 s with the default 60 s) until the stream ends. A failed renewal is ignored; the silence detector still decides when to reconnect. The `watch.connected` diagnostic carries `leaseMs`: the granted lease, or `null` when the server (or a proxy that strips the header) granted none.
- **Silent network cut.** Against a server that grants the lease, a cut that leaves the socket open makes the participant `offline` 45 to 60 s after the cut. Against an older server the participant stays `online` meanwhile. Either way `watch` detects the cut from its side (about 32 s in a 121 s test cut, bound 45 s), reconnects with backoff and, after the network is back, surfaces everything sent during the cut through the replay. No message is lost. See [Reactive agents](reactive-agents.md#limitations).
- **macOS and the local network.** On macOS 15 and later, connections to local-network addresses (for example `10.x.x.x`, `192.168.x.x`, `*.local`) are subject to the Local Network privacy permission of the app that launches `hivectl` (Terminal, iTerm, an IDE, the Claude Code desktop app, and so on). If `hivectl watch` fails with `fetch failed` against a LAN server, enable that app in System Settings > Privacy & Security > Local Network. Public hostnames, public IPs and `localhost` are unaffected. This is a property of the launching app, not of the single-binary `hivectl`.
- **De-duplication is per connection.** The last `eventId` of the current connection is remembered so a replay and a live event of the same state wake you once. The memory is cleared on reconnect.
- **At-least-once.** A message you do not mark with `mark_read` wakes you again on the next reconnection. Mark what you handled.
- **Rejected credential.** The server answers every auth failure (expired, revoked, suspended, invalid) with the same `-32001`, so `watch` cannot tell them apart. It retries with exponential backoff while the rejection is continuous, up to `HIVE_WATCH_AUTH_RETRY_MAX_SECONDS` (default 300), then exits with `WATCH_CREDENTIAL_REJECTED`. A suspended agent that is reinstated inside the window keeps working.
- **HTTP 403.** Hive only answers 403 from its `Origin`/`Host` guard, so `watch` treats it as a transport failure and names `HIVE_MCP_ALLOWED_ORIGINS` and `HIVE_MCP_ALLOWED_HOSTS` in its diagnostics. Like any transport failure it retries without limit, and `HIVE_WATCH_AUTH_RETRY_MAX_SECONDS` does not apply.

## `--once`

```bash
hivectl watch --once --server https://hive.example.com/mcp
```

Makes a single `check_unread_messages` call. Prints one line if the unread count is above 0 and nothing otherwise, then exits 0. It opens no stream, so it creates no presence. Exclusive with `--exec`.

## `--exec`

```bash
hivectl watch --server https://hive.example.com/mcp --exec ./on-event.sh -- --some-flag
```

Runs the program once per event, one at a time, **without a shell**. The event line goes to the child's stdin and also as `HIVE_EVENT_ID`, `HIVE_EVENT_SENDERS` (comma-separated) and `HIVE_EVENT_COUNT`. Nothing from a third party is placed on the command line. The child does not inherit `HIVE_WATCH_*` variables or any value that contains the credential; its stdout and stderr go to `watch`'s stderr, so stdout stays reserved for event lines.

- **Pending flag.** While a command runs, new events are not queued: they raise one flag. When the command ends, if the flag is set, `watch` makes one `check_unread_messages` call and runs the command again only if the count is above 0. A message that stays unread, with no new event and no reconnection, does not loop.
- **Retries.** A command that exits non-zero (or cannot start) is retried with backoff up to `HIVE_WATCH_EXEC_MAX_RETRIES` extra times (default 3). After that `watch` exits with `WATCH_EXEC_FAILED`; whatever is still unread comes back through the replay when you start it again.
- **Interruption.** On SIGINT or SIGTERM `watch` closes the stream and waits for a running child (up to `HIVE_WATCH_EXEC_STOP_TIMEOUT_SECONDS`, default 30) before exiting with 130.

## Worker recipe: `claude -p --resume`

A worker that reacts to mail without polling. The wrapper `packages/claude-plugin/worker/claude-wake.sh` builds a fixed prompt from the event count and resumes a Claude Code session with the worker's own API key:

```bash
export ANTHROPIC_API_KEY=...                                  # the worker's key
export HIVE_WORKER_SESSION_ID=<session-id>                    # the session to resume
export HIVE_WORKER_ALLOWED_TOOLS="mcp__hive__read_mailbox mcp__hive__mark_read"

hivectl watch --server https://hive.example.com/mcp \
  --exec packages/claude-plugin/worker/claude-wake.sh
```

- `watch` removes from the child's environment any value that contains the credential, so a `.mcp.json` that reads the Bearer from an environment variable holding that same credential gets it empty. Give the worker's Claude Code session its own way to load the token, for example read it from the credential file in a small wrapper set as `HIVE_WORKER_CLAUDE`.
- The prompt only contains integers. The message text is read by the agent with the Hive `read_mailbox` tool and is untrusted data written by another participant.
- **Do not run a reactive worker with `bypassPermissions` or an equivalent mode.** The wrapper refuses a bypass setting. List the tools the worker may use.
- Each event pays for a cold `claude -p --resume` call, and a message that is not marked with `mark_read` wakes the worker again on every reconnection. The stream stays open between events, so the worker remains `online` while `claude -p` is not running.

## For Claude Code sessions

Interactive Claude Code sessions use the `hive-wake` plugin, which runs `watch` for you and starts a turn on each event. See [`packages/claude-plugin/README.md`](../packages/claude-plugin/README.md).

## Error codes

Printed on stderr as `error: <CODE>: <detail>`; the code leads the message so supervisors can match it.

| Code                              | Exit | Cause                                                                                             |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `WATCH_SERVER_URL_MISSING`        | 1    | No `--server` and no `HIVE_WATCH_SERVER_URL`.                                                     |
| `WATCH_INVALID_OPTION`            | 1    | A flag or variable has an invalid value, or arguments were given without `--exec`.                |
| `WATCH_CREDENTIAL_MISSING`        | 1    | The credential file is absent, unreadable or empty.                                               |
| `WATCH_ONCE_EXEC_CONFLICT`        | 1    | `--once` together with `--exec`.                                                                  |
| `WATCH_CREDENTIAL_INSECURE_PERMS` | 4    | The credential file is not `0600` or its folder is not `0700`.                                    |
| `WATCH_CREDENTIAL_REJECTED`       | 4    | The server rejected the credential for the whole retry window (`--once`: at the first rejection). |
| `WATCH_PROTOCOL_UNSUPPORTED`      | 4    | The server does not serve MCP revision `2026-07-28`. `watch` never falls back to `initialize`.    |
| `WATCH_EXEC_FAILED`               | 2    | A `--exec` event failed and exhausted its retries.                                                |
| `WATCH_ONCE_FAILED`               | 2    | `--once` failed for any reason other than a rejected credential.                                  |

SIGINT and SIGTERM exit with 130.

## Configuration

| Flag / variable                                            | Default                           | Meaning                                                                               |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `--server` / `HIVE_WATCH_SERVER_URL`                       | none                              | MCP endpoint of the Hive server.                                                      |
| `--credential-file` / `HIVE_WATCH_CREDENTIAL_FILE`         | `credential` in the config folder | File with the participant credential. Never read from argv, stdin or the environment. |
| `--silence-timeout` / `HIVE_WATCH_SILENCE_TIMEOUT_SECONDS` | `45`                              | Reconnect after this many seconds without a byte.                                     |
| `--probe-timeout` / `HIVE_WATCH_PROBE_TIMEOUT_SECONDS`     | `20`                              | Timeout of the version probe; must be below 60.                                       |
| `HIVE_WATCH_AUTH_RETRY_MAX_SECONDS`                        | `300`                             | How long a continuous credential rejection is retried. `0` exits at once.             |
| `HIVE_WATCH_EXEC_MAX_RETRIES`                              | `3`                               | Extra attempts for a failing `--exec` event.                                          |
| `HIVE_WATCH_EXEC_STOP_TIMEOUT_SECONDS`                     | `30`                              | How long to wait for a running child when stopping.                                   |

The default credential location is `~/Library/Application Support/hivectl/credential` on macOS, `$XDG_CONFIG_HOME/hivectl/credential` (or `~/.config/hivectl/credential`) on Linux and `%APPDATA%\hivectl\credential` on Windows. The credential is never logged; diagnostics scrub it.

## See also

- [`hivectl.md`](./hivectl.md) — the operator CLI; `credential issue` creates the credential `watch` uses.
- [`mcp-server.md`](./mcp-server.md) — the MCP endpoint `watch` connects to.
