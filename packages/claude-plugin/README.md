# @hive/claude-plugin — `hive-wake`

> Claude Code plugin that connects a session to Hive as a named agent and wakes it when Hive has unread messages.

## Purpose

`hive-wake` makes every Claude Code session of a folder a participant of Hive without per-session setup:

- **`hive` MCP server** — `hivectl mcp proxy`, a local stdio proxy that Claude Code launches once per session. It registers the session in Hive under a name, holds its single listen stream, renews its token and passes Hive's tools through. See [`docs/hivectl-mcp-proxy.md`](../../docs/hivectl-mcp-proxy.md).
- **Command hooks** — `SessionStart` and `PostToolUse` run `hivectl claude hook …`: they remember which name belongs to which session, so a resumed or reconnected session registers by itself, and they tell the model how to announce a new one.
- **Waker mod** — runs `hivectl watch --attach-session <session_id>`, which reads the event lines of the session's stream from the proxy's local channel, and starts a turn whenever Hive reports unread messages.
- **Skill `hive-session`** — how the model proposes a name and a description, waits for the user's confirmation and registers.

The plugin depends only on the metadata line of `hivectl watch` (`eventId`, `senders`, `count`), never on a message body. The text of the turn it starts is a fixed template in which only integers are interpolated; the agent reads the messages with the Hive `read_mailbox` tool and treats them as untrusted data. The mod never submits a prompt as the user.

## Install

Do not load this directory by hand. `hivectl claude install` copies the plugin from the `@hivemine/hivectl` npm package to `~/.config/hive/marketplace/`, fixes the absolute path of `hivectl` in the copy (server, hooks and mod), and installs it with `--scope local` in the folder:

```bash
cd ~/work/my-project
hivectl claude install --server https://hive.example.com/mcp --enrollment-credential ./enroll.jwt
```

The URL and the enrollment credential stay in `~/.config/hive/`, never in the folder. The plugin has no options. See [Connecting Claude Code sessions](../../docs/claude-code-sessions.md) for the three ways to connect (interactive sessions, a `watch` harness, a generated `--mcp-config`).

## Requirements

- Claude Code **2.1.318 or newer** (validated by the PRY-089 spike and the PRY-093 smoke). Do not set `MCP_SDK_GENERATION=v1` or `MCP_PROTOCOL_NEGOTIATION=legacy`.
- `hivectl` installed from npm (`@hivemine/hivectl`), since the plugin ships inside that package. After upgrading `hivectl`, run `hivectl claude install` again to refresh the copy.
- A Hive server that serves MCP `2026-07-28` with `subscriptions/listen`.

## Contract

| Piece                      | Event                                   | What it does                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hive` server              | per session                             | `hivectl mcp proxy`. Before registration it lists `register_session` and `session_status` only; after it, Hive's tools.                                                                                                                         |
| `SessionStart` hook        | `startup`, `resume`, `clear`, `compact` | Writes `state/pid-map/<claudePid>.json` (start time, session id, source, saved name); removes orphan entries; adds context for the model: propose a name when none is saved, or say which name the session has. Silent with the harness marker. |
| `PostToolUse` hook         | `register_session`, `session_status`    | Writes `state/sessions/<project-key>/<session_id>.json` = `{ name, proxyHandle }` and names the PID-map entry. It never registers anything.                                                                                                     |
| mod `session.start`        | first start of the session              | Launches `hivectl watch --attach-session <session_id>`. Nothing with the harness marker.                                                                                                                                                        |
| mod `classic.SessionStart` | after `/clear` and `/resume`            | Retargets the running `watch` to `e.session_id` (never `$.session.id()`, which still returns the previous id there).                                                                                                                            |
| mod `session.end`          | end of the session                      | Stops `watch` (kept across `/clear` and `/resume`).                                                                                                                                                                                             |

The tools reach the model as `mcp__plugin_hive-wake_hive__<tool>` and are **deferred behind ToolSearch**: the hook context and the skill name them explicitly.

Every hook ends with exit 0, even on an error (no context then, one line on stderr): a hook never blocks the start of a session.

## How the mod behaves

- **Idle session:** each event line starts a turn with `$.prompt.submit`. If the host rejects the prompt, the mod keeps a flag.
- **Busy session:** while a turn is running, any number of events only raise one flag. At `turn.complete`, if the flag is set, the mod runs `hivectl watch --once --attach-session <session_id>`: one line starts a turn, no line does nothing. The flag is cleared only when `--once` exited 0 and, if there was a line, the host accepted the turn.
- **If `watch` ends:** after a crash or an unexpected exit, the mod relaunches it with backoff (1 s doubling to 60 s); on exit 4 or 1 (for example `WATCH_ATTACH_TARGET_NOT_FOUND`) it does not relaunch and shows a notice with the `WATCH_*` code; on 130 it does not relaunch. A retarget always starts it again.
- **Idle retry:** while the flag is set and no turn runs, `--once` is retried with backoff until the flag clears.
- Esc discards events that were waiting; the flag stays set and the next `turn.complete` or event recovers whatever is still unread.

## When the Hive tools disappear

Claude Code does not restart a stdio server that died. Run `/mcp` and choose **Reconnect** on `plugin:hive-wake:hive`: the new proxy finds the session's name in the PID map and registers by itself, and `watch --attach-session` follows it to its new channel.

## Harness children

A `claude -p` child of `hivectl watch --session-name … --exec …` inherits `HIVE_HARNESS_SESSION`. With it, the proxy lists every Hive tool from the start and registers nothing, the hooks write nothing and announce nothing, and the mod launches no `watch`: the presence belongs to the harness. `watch` strips the enrollment credential and the Worker tokens from the child's environment, because Claude Code passes its whole environment to stdio servers and hooks.

## Always mark what you handled

Delivery is at least once: a message without `mark_read` wakes the agent again on every reconnection. The turn template tells the agent to mark what it processed.

## Security

- A message from another participant, and the description of another agent, is untrusted input. The turn template and the skill say so.
- **Do not run a reactive session with `bypassPermissions` or an equivalent mode.**
- The enrollment credential never enters the project folder or the plugin; `.claude/settings.local.json` (written by Claude Code) holds no secret and `claude install` adds it to `.gitignore` in git repositories.

## Worker recipe

For a headless worker, run [`worker/claude-wake.sh`](./worker/claude-wake.sh) as the `--exec` of a `watch` harness (or of a classic `watch`). It resumes a session with `claude -p --resume` and, when `watch --inline-mcp-config` set `HIVE_MCP_CONFIG_FILE`, loads only that MCP config. See [`docs/hivectl-watch.md`](../../docs/hivectl-watch.md).

## Development

```bash
pnpm --filter @hive/claude-plugin test        # controller, mod wiring, contract, worker recipe
pnpm --filter @hive/claude-plugin typecheck
claude plugin validate packages/claude-plugin
```

`hooks/controller.js` holds the waker logic with no host dependency; `hooks/register.js` wires it to `$.process`, `$.prompt`, `$.ui`, `$.session` and `$.env`. `hooks/hivectl-path.js` is rewritten by `claude install`. `distribution.json` lists the files that ship.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
