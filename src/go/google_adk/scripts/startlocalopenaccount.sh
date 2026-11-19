#!/bin/bash
# Run the open-account workflow's three scenarios with no chat and no model
# (see cmd/openaccount). Starts a worker in the background and stops it on exit.
# Usage: startlocalopenaccount.sh [open-account-task-queue]
# With a queue name, the workflow runs on that queue, so a worker for it must be running.
cd "$(dirname "$0")" || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Running the open-account workflow on task queue $1. ***"
fi
BIN_DIR="$(mktemp -d)"
trap 'kill "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null; rm -rf "$BIN_DIR"' EXIT
go build -o "$BIN_DIR/worker" ../cmd/worker || exit 1
go build -o "$BIN_DIR/openaccount" ../cmd/openaccount || exit 1
echo "Starting the worker and running the three scenarios for the open-account workflow."
"$BIN_DIR/worker" > "$BIN_DIR/worker.log" 2>&1 &
WORKER_PID=$!
"$BIN_DIR/openaccount"
