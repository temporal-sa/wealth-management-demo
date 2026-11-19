#!/bin/bash
# Start the Temporal + Strands worker against Temporal Cloud (settings from
# scripts/setcloudenv.sh; copy scripts/setcloudenv.example).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's Strands-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=Strands-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
   echo "scripts/setcloudenv.sh not found (copy scripts/setcloudenv.example)"
   exit 1
fi
source ../../../../scripts/setcloudenv.sh
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
uv run python -m durable.run_worker
