#!/bin/bash
# Start the Temporal + Google ADK worker against Temporal Cloud (settings from
# scripts/setcloudenv.sh; copy scripts/setcloudenv.example).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this framework's ADK-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this framework too (TEMPORAL_TASK_QUEUE=ADK-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
for f in setcloudenv setgeminikey; do
  if [ ! -f ../../../../scripts/$f.sh ]; then
     echo "scripts/$f.sh not found (copy scripts/$f.example)"
     exit 1
  fi
done
source ../../../../scripts/setcloudenv.sh
source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python -m durable.run_worker
