#!/bin/bash
# Start the Temporal + Google ADK worker against Temporal Cloud (settings from
# scripts/setcloudenv.sh; copy scripts/setcloudenv.example).
# Usage: startcloudworker.sh [open-account-task-queue]
# With a task queue name, the open-account child workflow runs on that queue (set as
# TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't register the Python
# version of it: start the Java worker with the same name (interop/open_account/java/startcloudworker.sh, with
# TEMPORAL_TASK_QUEUE=ADK-Supervisor so it calls this port's activities).
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
