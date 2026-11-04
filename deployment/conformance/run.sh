#!/usr/bin/env bash
# Runs the official MCP conformance suite against a throwaway Hive server.
# Requires `pnpm -r build` first. See docs/mcp-conformance.md.
#
#   deployment/conformance/run.sh [extra conformance args...]
set -euo pipefail

SUITE_VERSION="0.2.0-alpha.12"
REVISION="2026-07-28"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SERVER_PORT="${CONFORMANCE_SERVER_PORT:-18443}"
PROXY_PORT="${CONFORMANCE_PROXY_PORT:-18444}"
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK/keys"
export HIVE_DB_URL="sqlite:$WORK/hive.sqlite"
export HIVE_AUTH_KEYS_DIR="$WORK/keys"
export HIVE_MCP_HTTP_HOST=127.0.0.1
export HIVE_MCP_HTTP_PORT="$SERVER_PORT"
# The dns-rebinding scenario sends a loopback Origin and expects it to pass.
export HIVE_MCP_ALLOWED_ORIGINS="http://127.0.0.1:$PROXY_PORT"

node "$ROOT/packages/cli/dist/main.js" init \
  --admin-email conformance@hive.test \
  --admin-display-name 'Conformance Admin' \
  --db "$HIVE_DB_URL" --keys-dir "$HIVE_AUTH_KEYS_DIR" \
  --output-credential "$WORK/admin.jwt" > /dev/null

node "$ROOT/packages/cli/dist/main.js" serve > "$WORK/server.log" 2>&1 &
PIDS+=($!)

# The conformance CLI cannot send custom headers; the proxy adds the Bearer.
node "$HERE/auth-proxy.mjs" "$PROXY_PORT" "$SERVER_PORT" "$WORK/admin.jwt" &
PIDS+=($!)

ready=0
for _ in $(seq 1 30); do
  if curl --max-time 2 -fsS "http://127.0.0.1:$PROXY_PORT/readyz" > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "server did not become ready" >&2
  cat "$WORK/server.log" >&2 || true
  exit 1
fi

cd "$WORK"
timeout 600 npx --yes "@modelcontextprotocol/conformance@$SUITE_VERSION" server \
  --url "http://127.0.0.1:$PROXY_PORT/mcp" \
  --requirements "$REVISION" \
  --expected-failures "$HERE/baseline.yml" \
  --output-dir "${CONFORMANCE_OUTPUT_DIR:-$WORK/results}" \
  "$@"
