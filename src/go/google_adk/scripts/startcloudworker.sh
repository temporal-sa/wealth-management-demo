#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: startcloudworker.sh [open-account-task-queue]
# A queue name moves the open-account workflow onto that queue: this worker then
# doesn't run it, and another worker must poll that queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in first."
  exit 1
fi
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
source ../../../../scripts/setcloudenv.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Using $1 as the task queue for the open-account workflow. ***"
fi
exec go run ../cmd/worker
