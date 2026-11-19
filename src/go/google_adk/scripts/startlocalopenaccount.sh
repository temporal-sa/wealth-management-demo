#!/bin/bash
# Run the open-account workflow's three scenarios with no chat and no model
# (see cmd/openaccount). Starts a worker in the background and stops it on exit.
# Usage: startlocalopenaccount.sh [java | <open-account task queue>] [runner arguments]
# With java, the workflow runs on this port's ADK-Go-Supervisor-open-account: start the Java worker for
# this port first (TEMPORAL_TASK_QUEUE=ADK-Go-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
BIN_DIR="$(mktemp -d)"
trap 'kill "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null; rm -rf "$BIN_DIR"' EXIT
go build -o "$BIN_DIR/worker" ../cmd/worker || exit 1
go build -o "$BIN_DIR/openaccount" ../cmd/openaccount || exit 1
echo "Starting the worker and running the three scenarios for the open-account workflow."
"$BIN_DIR/worker" > "$BIN_DIR/worker.log" 2>&1 &
WORKER_PID=$!
"$BIN_DIR/openaccount"
