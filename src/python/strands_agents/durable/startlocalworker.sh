#!/bin/bash
# Start the Temporal + Strands worker locally.
# Usage: startlocalworker.sh [open-account-task-queue]
# With a task queue name, the open-account child workflow runs on that queue (set as
# TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't register the Python
# version of it: start the Java worker with the same name (interop/open_account/java/startlocalworker.sh, with
# TEMPORAL_TASK_QUEUE=wealth-management-strands so it calls this port's activities).
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Using $1 as the task queue for the open-account workflow. Remember to also start the Java worker with it. ***"
fi
uv run python -m durable.run_worker
