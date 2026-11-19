#!/bin/bash
# Start the worker against a local Temporal dev server.
# Usage: startlocalworker.sh [open-account-task-queue]
# A queue name moves the open-account workflow onto that queue: this worker then
# doesn't run it, and another worker (for example the Java one) must poll that queue.
cd "$(dirname "$0")" || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
[ -f ../setgeminikey.sh ] && source ../setgeminikey.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Using $1 as the task queue for the open-account workflow. ***"
fi
exec go run ../cmd/worker
