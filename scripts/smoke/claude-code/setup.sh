#!/bin/sh
# Prepares a throwaway smoke environment for the Claude Code end-to-end smoke
# of named sessions (ADR-026, PRY-093): a hivectl install root laid out like
# the npm package (binary + better-sqlite3 + the staged hive-wake plugin), a
# local SQLite Hive, an enrollment credential and an env.sh to source.
#
#   scripts/smoke/claude-code/setup.sh <smoke-dir> [<hivectl-binary>]
#
# <hivectl-binary> defaults to packages/cli/dist-sea/hivectl (build it with
# `pnpm --filter @hive/cli sea:build:<platform>`). Nothing outside <smoke-dir>
# is written, except what `hivectl claude install` later asks Claude Code to do.
set -eu

[ $# -ge 1 ] || { echo "usage: $0 <smoke-dir> [<hivectl-binary>]" >&2; exit 2; }
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
SMOKE=$(mkdir -p "$1" && cd "$1" && pwd)
BINARY=${2:-$REPO/packages/cli/dist-sea/hivectl}
PORT=${HIVE_SMOKE_PORT:-18093}

[ -x "$BINARY" ] || { echo "no hivectl binary at $BINARY" >&2; exit 2; }
mkdir -p "$SMOKE/bin/node_modules" "$SMOKE/hive" "$SMOKE/config" "$SMOKE/logs" "$SMOKE/projA" "$SMOKE/projB"
chmod 700 "$SMOKE/hive" "$SMOKE/config"
cp "$BINARY" "$SMOKE/bin/hivectl"
SQLITE=$(cd "$REPO/packages/server" && node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")
ln -sfn "$SQLITE" "$SMOKE/bin/node_modules/better-sqlite3"
node -e "
const fs = require('fs'), path = require('path');
const [src, dst] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(path.join(src, 'distribution.json'), 'utf8'));
for (const f of ['distribution.json', ...d.files]) {
  const t = path.join(dst, f);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.copyFileSync(path.join(src, f), t);
}" "$REPO/packages/claude-plugin" "$SMOKE/bin/claude-plugin"

cat > "$SMOKE/env.sh" <<ENV
export SMOKE=$SMOKE
export PATH=$SMOKE/bin:\$PATH
export HIVE_DB_DIALECT=sqlite
export HIVE_DB_URL=sqlite:$SMOKE/hive/hive.sqlite
export HIVE_AUTH_KEYS_DIR=$SMOKE/hive/keys
export HIVE_MCP_HTTP_HOST=127.0.0.1
export HIVE_MCP_HTTP_PORT=$PORT
export HIVE_CONFIG_DIR=$SMOKE/config
export HIVE_SMOKE_URL=http://127.0.0.1:$PORT/mcp
ENV
. "$SMOKE/env.sh"

cd "$SMOKE/hive"
hivectl --output json init --admin-email smoke@example.com --admin-display-name Smoke \
  --hive-name smoke --db "$HIVE_DB_URL" --keys-dir "$HIVE_AUTH_KEYS_DIR" --ttl 30d \
  --output-credential "$SMOKE/hive/admin.jwt" --yes > "$SMOKE/logs/init.json"
hivectl --output json credential issue --enrollment --owner smoke@example.com --ttl 7d \
  --output-credential "$SMOKE/hive/enroll.jwt" --reason "Claude Code smoke" > "$SMOKE/logs/enroll.json"
printf '# projA\n\nSmoke project: a small API service for invoices.\n' > "$SMOKE/projA/CLAUDE.md"
(cd "$SMOKE/projA" && git init -q .)
echo "ready: . $SMOKE/env.sh"
