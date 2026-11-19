#!/bin/bash
# Start the worker against Temporal Cloud, with the settings in scripts/setcloudenv.sh
# (copy scripts/setcloudenv.example).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's ADK-TS-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=ADK-TS-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "**** setcloudenv.sh not found. Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in."
  exit 1
fi
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
npm run --silent temporal:worker
