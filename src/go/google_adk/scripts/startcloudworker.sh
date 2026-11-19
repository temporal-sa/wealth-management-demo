#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's ADK-Go-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=ADK-Go-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
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
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
exec go run ../cmd/worker
