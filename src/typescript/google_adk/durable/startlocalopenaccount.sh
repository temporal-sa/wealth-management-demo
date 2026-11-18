#!/bin/bash
# Run the open-account workflow on its own, with no chat and no model, for three scenarios (see
# run_open_account_workflow.ts). It starts a worker in the background, which needs no model key, and
# stops it on exit.
# Usage: startlocalopenaccount.sh [open-account task queue] [--scenario N ...] [--amount X]
# With a queue name, the workflow runs on that queue: start the Java worker on it first
# (interop/open_account/java/startlocalworker.sh <queue>, with TEMPORAL_TASK_QUEUE=ADK-TS-Supervisor).
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Running the open-account workflow on task queue $1 (the Java worker must poll it). ***"
  shift
fi
cd .. || exit 1
# ts-node is started directly, not through npm, so $! is the worker's own PID and the trap stops it
../node_modules/.bin/ts-node durable/worker.ts &
WORKER_PID=$!
trap 'kill "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null' EXIT
npm run --silent open-account.scenarios -- "$@"
