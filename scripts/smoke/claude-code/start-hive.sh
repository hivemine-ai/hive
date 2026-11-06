#!/bin/sh
# Starts the smoke Hive in the background (bounded by a 4 hour timeout) and
# waits for /healthz. Source env.sh first. The PID lands in $SMOKE/serve.pid.
set -eu
cd "$SMOKE/hive"
nohup timeout 14400 hivectl serve --log-level info > "$SMOKE/logs/serve.log" 2>&1 &
echo $! > "$SMOKE/serve.pid"
i=0
until curl -fs -o /dev/null "http://127.0.0.1:$HIVE_MCP_HTTP_PORT/healthz"; do
  i=$((i + 1)); [ $i -lt 30 ] || { echo "the smoke Hive did not start" >&2; exit 1; }
  sleep 1
done
echo "hive up on $HIVE_SMOKE_URL (pid $(cat "$SMOKE/serve.pid"))"
