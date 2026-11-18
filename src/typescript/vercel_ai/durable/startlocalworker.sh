#!/bin/bash
# Start the Temporal + Vercel AI SDK worker locally.
# Usage: startlocalworker.sh [open-account-task-queue]
# With a task queue name, the open-account child workflow runs on that queue (set as
# TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't register the TypeScript version of it:
# start the Java worker with the same name (interop/open_account/java/startlocalworker.sh, with
# TEMPORAL_TASK_QUEUE=VAI-Supervisor so it calls this port's activities).
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setgeminikey.sh ]; then
   echo "scripts/setgeminikey.sh not found (copy scripts/setgeminikey.example)"
   exit 1
fi
source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
npm run temporal:worker
