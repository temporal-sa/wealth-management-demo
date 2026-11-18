#!/bin/bash
# Start the worker against a local Temporal service.
# Usage: startlocalworker.sh [open-account task queue]
# With a queue name, the open-account workflow runs on that queue instead (start the Java worker with
# the same name: java/startlocalworker.sh <queue>), and this worker doesn't register its own.
cd "$(dirname "$0")" || exit 1
[ -f ../../setgeminikey.sh ] && source ../../setgeminikey.sh
[ -f ../../setclaimcheck.sh ] && source ../../setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** The open-account workflow runs on task queue $1: start the Java worker on it. ***"
fi
npm run --silent temporal:worker
