# Claude Code end-to-end smoke (named sessions)

A manual smoke of named Claude Code sessions (ADR-026) against a real Claude Code, a local Hive and the `hivectl` binary built from your checkout. It is what the PRY-093 evidence was produced with and what a release smoke re-runs. It is **not** run in CI: it needs a logged-in Claude Code and spends model turns.

## Safety rules

- Use a **throwaway directory** for everything (`<smoke-dir>` below); never your real projects.
- Use **`--scope local`** only (what `hivectl claude install` does) and never install the plugin with `--scope user`.
- Use your existing Claude Code login. No API key is needed; pass `--model haiku` (the scripts default to it).
- Run interactive sessions in a **tmux session of your own** (`tmux new-session -d -s hive-smoke …`); never send keys to a session you are using.
- Before starting, snapshot the plugin files of your Claude Code config dir (`$CLAUDE_CONFIG_DIR`, default `~/.claude`): `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `settings.json`, and the listing of `plugins/cache`. Compare after the cleanup.

## Files

| File                 | What it does                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`           | `setup.sh <smoke-dir> [<hivectl-binary>]`: lays out `<smoke-dir>/bin` like the npm package (binary, `better-sqlite3`, staged plugin), runs `hivectl init` on SQLite, issues an enrollment credential, writes `env.sh`. |
| `start-hive.sh`      | Starts `hivectl serve` on `127.0.0.1:$HIVE_SMOKE_PORT` (default `18093`) in the background and waits for `/healthz`.                                                                                                   |
| `clean.sh`           | Runs a command without the variables of a parent Claude Code session or tmux pane.                                                                                                                                     |
| `wake.sh`            | The `--exec` child of a `watch` harness: one `claude -p` per event; records its env, samples the env of every live proxy and keeps the stream-json, under `<smoke-dir>/logs`.                                          |
| `hivetool.mjs`       | Another participant (`smoke-sender`): `send <ref> <body>`, `status <ref>`, `list`. Needs `pnpm build`.                                                                                                                 |
| `audit.sh`           | `agent_enrolled` / `agent_claimed` rows of the smoke Hive, with the agent name.                                                                                                                                        |
| `validate-plugin.sh` | `claude plugin validate packages/claude-plugin` (the CI runners have no `claude` CLI).                                                                                                                                 |

## Run

```bash
pnpm install && pnpm build && pnpm --filter @hive/cli sea:build:darwin   # or :linux
scripts_dir=$PWD/scripts/smoke/claude-code
S=$(mktemp -d)/smoke                                                       # throwaway
$scripts_dir/setup.sh "$S"
. "$S/env.sh"
$scripts_dir/validate-plugin.sh
$scripts_dir/start-hive.sh
cd "$S/projA"
$scripts_dir/clean.sh hivectl claude install --server "$HIVE_SMOKE_URL" --enrollment-credential "$S/hive/enroll.jwt"
tmux new-session -d -s hive-smoke -c "$S/projA" "/bin/zsh -f"
tmux send-keys -t hive-smoke: ". $S/env.sh; $scripts_dir/clean.sh claude --model haiku" Enter
```

Then go through the cases, checking `$HIVE_CONFIG_DIR/state/` (`pid-map/`, `proxies/`, `sessions/`, `harness/`), `ps -axo pid,ppid,command | grep hivectl`, `node hivetool.mjs status <ref>` and `audit.sh`:

1. `claude install` writes only `.claude/settings.local.json` in the folder; the plugin copy pins the absolute `hivectl` in the server, the hooks and the mod.
2. Interactive announce: the model proposes a name and a description and waits for confirmation; after it, the session is `online`.
3. `hivetool.mjs send <ref> …` wakes the idle session with the fixed notice.
4. `/clear`: same proxy, the new session id inherits the name, the waker follows it, still woken; no `agent_claimed`.
5. `/resume` (and `/compact`): the name comes back; an unnamed conversation does not inherit the live name; a conversation saved under another name keeps the live one and the context says so.
6. `kill -9` the proxy, then `/mcp` → Reconnect: the new proxy registers by itself; no `agent_claimed`.
7. A second session in the same folder asking for the same name gets `name_in_use`; under another name both message each other.
8. `claude --resume <id>`: registered before the first turn; `/exit` and `kill -9` of `claude` make it `offline` at once.
9. `hivectl watch --session-name … --exec $scripts_dir/wake.sh` in `projA`: children have every Hive tool, announce nothing, and no credential in their env (grep the enrollment JWT and the token of the state file in `logs/*.wake-env` and `logs/*.proxy-env`).
10. The same in `projB` with `--server … --credential-file … --inline-mcp-config` (no plugin).
11. A second harness with the same name exits `WATCH_SESSION_NAME_IN_USE`; `kill -9` and a relaunch renew (no `agent_claimed`).

## Cleanup

```bash
pkill -TERM -f "watch --session-name"          # the harnesses delete their state files
tmux send-keys -t hive-smoke: "/exit" Enter; tmux kill-session -t hive-smoke
(cd "$S/projA" && $scripts_dir/clean.sh hivectl claude uninstall --yes)
kill "$(cat "$S/serve.pid")"
```

`claude plugin uninstall` leaves a copy of the plugin under `plugins/cache/hive/hive-wake/<version>` in the Claude Code config dir. It holds no secret (the plugin carries no credential) and is harmless; remove it by hand if you want the cache listing to match your snapshot. Remove the transcripts of the throwaway projects under `projects/` of the config dir and then `<smoke-dir>`.
