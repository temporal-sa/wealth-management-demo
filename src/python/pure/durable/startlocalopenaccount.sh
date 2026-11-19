#!/bin/bash
# Run the open-account workflow's three scenarios without the chat or the model
# (see run_open_account_workflow.py). Starts a local worker in the background, which
# needs no model key, and stops it when the scenarios finish.
# it first.
# Usage: startlocalopenaccount.sh [java | <open-account task queue>] [runner arguments]
# With java, the workflow runs on this port's Pure-Supervisor-open-account: start the Java worker for
# this port first (TEMPORAL_TASK_QUEUE=Pure-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
[ -f ../../../../scripts/setllmkey.sh ] && source ../../../../scripts/setllmkey.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
echo "Starting the worker and running the three scenarios for the open-account workflow."
uv run python run_worker.py &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null; wait $WORKER_PID 2>/dev/null' EXIT
uv run python run_open_account_workflow.py
