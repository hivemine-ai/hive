# @hive/claude-plugin — `hive-wake`

> Claude Code plugin that wakes an idle session when Hive has unread messages.

## Purpose

The MCP standard does not let a server start a turn, so an idle Claude Code session never finds out that a message arrived. `hive-wake` is a Claude Code **mod** that runs [`hivectl watch`](../../docs/hivectl-watch.md) next to the session and starts a turn whenever Hive reports unread messages.

It depends only on the metadata line printed by `hivectl watch` (`eventId`, `senders`, `count`), never on the MCP wire format and never on a message body. The text of the turn it starts is a fixed template in which only integers are interpolated; the agent reads the messages with the Hive `read_mailbox` tool and treats them as untrusted data from another participant. The mod never submits a prompt as the user.

> **Status: provisional.** The mod adapter has been proven against a real Hive session by the PRY-073 spike, but its recovery path (server replay and `watch --once`) is only confirmed against real Claude Code in the v0.2.0 smoke (PRY-081). Mods are an early-access surface of Claude Code and can change between releases.

## Requirements

- Claude Code **2.1.232 or newer** (2.1.274 or newer if you do not enable feature flags). Do not set `MCP_SDK_GENERATION=v1` or `MCP_PROTOCOL_NEGOTIATION=legacy`: they break the HTTP entry to a Hive that only speaks the `2026-07-28` revision.
- `hivectl` on the `PATH` (the plugin does not bundle it) and a credential file for the agent, mode `0600` in a folder that is `0700`.
- A Hive server that serves `subscriptions/listen`. Claude Code waits 5 seconds for the server's `server/discover` answer; a slower server can leave the session without Hive tools.
- Hive is registered in Claude Code as an ordinary HTTP MCP server. The plugin does not register it for you.

## Install

There is no marketplace listing. The plugin is a directory of this repository, so load it straight from there:

```bash
git clone https://github.com/hivemine-ai/hive.git
claude --plugin-dir ./hive/packages/claude-plugin
```

`--plugin-dir` applies to that session. Add the flag to the alias or script you start Claude Code with to make it permanent.

Then set the plugin options. A plugin loaded this way has the id `hive-wake@inline`, and `claude plugin configure` only finds it with `--plugin-dir` before the subcommand; `claude plugin configure hive-wake` answers that no installed plugin has that id:

```bash
echo '{"server_url":"https://hive.example.com/mcp","credential_file":"/path/to/credential"}' |
  claude --plugin-dir ./hive/packages/claude-plugin plugin configure hive-wake@inline --values-stdin
```

That saves the values under `pluginConfigs` in your user settings. For one session only, pass the same object with `--settings`:

```json
{
  "pluginConfigs": {
    "hive-wake@inline": { "options": { "server_url": "https://hive.example.com/mcp" } }
  }
}
```

| Option            | Required | Meaning                                                                       |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `server_url`      | yes      | MCP endpoint of your Hive, for example `https://hive.example.com/mcp`.        |
| `credential_file` | no       | Path of the agent's credential file. Empty uses `hivectl`'s default location. |
| `hivectl_path`    | no       | Path or name of the `hivectl` executable. Default `hivectl`.                  |

The credential itself is never an option and never reaches the plugin: it only passes the file path to `hivectl`.

## How it behaves

- At session start the mod launches `hivectl watch`. While that process runs, your agent counts as `online`.
- **Idle session:** each event line starts a turn with `$.prompt.submit`. If the host rejects the prompt, the mod keeps a flag.
- **Busy session:** while a turn is running, any number of events only raise one flag. At `turn.complete`, if the flag is set, the mod runs `hivectl watch --once`. If that prints a line, it starts a turn; if it prints nothing, it does nothing. The flag is cleared only when `--once` exited 0 and, if there was a line, the host accepted the turn. Otherwise it is kept and retried at the next `turn.complete` or event.
- **If `watch` ends:**
  - after a crash or any unexpected exit, the mod relaunches it with backoff (1 s doubling to 60 s, back to 1 s after a run of 60 s or more); the server replay brings the agent up to date. After five short runs in a row it shows a warning but keeps trying;
  - on `EXIT_PRECONDITION` (4) or `EXIT_USER_ERROR` (1), including `WATCH_CREDENTIAL_REJECTED`, relaunching cannot fix it: the mod does not relaunch and shows a notice with the `WATCH_*` code taken from `watch`'s last stderr line;
  - on `EXIT_INTERRUPTED` (130) it does not relaunch;
  - if `hivectl` cannot be started at all, it shows a notice and does not relaunch.
- **Idle retry.** If a prompt is rejected, or `--once` fails, while no turn is running, no `turn.complete` will come to recover the flag. The mod then retries `--once` with backoff (1 s doubling to 60 s) for as long as the flag is set. The retry is cancelled when a turn starts, when the flag clears, and when the session ends. The retry stops on the exits that also keep `watch` from restarting (usage error, failed precondition such as a rejected credential, interrupted): the mod warns once, keeps the flag, and asks again at the next `turn.complete` or event.
- **Session end.** At `session.end` the mod stops `watch` and drops its state; the next `session.start` begins from scratch.
- Esc discards events that were waiting: Claude Code rejects `$.prompt.submit` after Esc until the next user input. The flag stays set and the next `turn.complete` or event recovers whatever is still unread.

## Known limit: `watch` is not tied to Claude Code's life

`$.process.spawn` closes the child's stdin from the start, so `watch` cannot use stdin EOF to notice that its parent died, and the mod does not ask it to. Observed once, on macOS with Claude Code 2.1.316: after `kill -9` of Claude Code, a child that ignored SIGHUP was reparented to PID 1 and kept running; when the terminal hung up, an ordinary child died with it. So a `watch` can be left behind when Claude Code is killed without a hangup (for example outside a terminal), and the participant then stays `online` with nobody listening. This is one observation, not a guarantee in either direction; it is checked again in the v0.2.0 smoke (PRY-081). If you see a stray `hivectl watch`, kill it.

## Always mark what you handled

`hivectl watch` has at-least-once semantics. A message that is not marked with `mark_read` is still counted by `check_unread_messages`, so it wakes the agent again on every reconnection. The turn template tells the agent to mark what it processed.

## Fallbacks

The mod is the primary adapter. If it stops working with a Claude Code release, two fallbacks exist, in this order: a **plugin monitor** that runs `hivectl watch`, then an **`asyncRewake` hook** (`Stop`). **They are not shipped in this version.** Both only deliver each line to the host: they do not see the turn, they have no flag and no `--once`, and they do not relaunch `watch`. Whatever the host discards is recovered at the next event or reconnection. `asyncRewake` also goes deaf when its `timeout` expires and accumulates duplicate processes, and while it is between runs the participant is `offline`. A Channels bridge is only worth building if all of them fail.

## Security

- A message from another participant is untrusted input. The turn template says so and points the agent at `read_mailbox`; it never contains message text, sender ids or event ids.
- **Do not run a reactive session with `bypassPermissions` or an equivalent mode.** A message from another participant would then drive tools without confirmation.
- Use a dedicated credential with a short TTL for the agent (`hivectl credential issue --ttl ...`) and rotate it with `credential rotate`. Never commit the credential file; do not put it in a versioned settings file.

## Worker recipe

For a headless worker, use `hivectl watch --exec` with `claude -p --resume` instead of this plugin. The wrapper lives in [`worker/claude-wake.sh`](./worker/claude-wake.sh) and is documented in [`docs/hivectl-watch.md`](../../docs/hivectl-watch.md#worker-recipe-claude--p---resume).

## Development

```bash
pnpm --filter @hive/claude-plugin test        # controller, hooks wiring, worker recipe
pnpm --filter @hive/claude-plugin typecheck
claude plugin validate packages/claude-plugin
```

The controller (`hooks/controller.js`) holds all the logic and has no host dependency; `hooks/register.js` only wires it to `$.process`, `$.prompt` and `$.ui`.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
