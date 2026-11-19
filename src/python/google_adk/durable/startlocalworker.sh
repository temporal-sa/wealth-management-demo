#!/bin/bash
# Start the Temporal + Google ADK worker locally.
# Usage: startlocalworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this framework's ADK-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this framework too (TEMPORAL_TASK_QUEUE=ADK-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setgeminikey.sh ]; then
   echo "scripts/setgeminikey.sh not found (copy scripts/setgeminikey.example)"
   exit 1
fi
source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python -m durable.run_worker
