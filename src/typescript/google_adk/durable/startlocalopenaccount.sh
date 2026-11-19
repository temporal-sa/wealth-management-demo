#!/bin/bash
# Run the open-account workflow on its own, with no chat and no model, for three scenarios (see
# run_open_account_workflow.ts). It starts a worker in the background, which needs no model key, and
# stops it on exit.
# Usage: startlocalopenaccount.sh [java | <open-account task queue>] [runner arguments]
# With java, the workflow runs on this framework's ADK-TS-Supervisor-open-account: start the Java worker for
# this framework first (TEMPORAL_TASK_QUEUE=ADK-TS-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this framework's <task queue>-open-account, for the Java worker). ***"
  shift
fi
cd .. || exit 1
# ts-node is started directly, not through npm, so $! is the worker's own PID and the trap stops it
../node_modules/.bin/ts-node durable/worker.ts &
WORKER_PID=$!
trap 'kill "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null' EXIT
npm run --silent open-account.scenarios -- "$@"
