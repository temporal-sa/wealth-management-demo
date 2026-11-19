#!/bin/bash
# Start the Temporal + Vercel AI SDK worker locally.
# Usage: startlocalworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's VAI-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=VAI-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setgeminikey.sh ]; then
   echo "scripts/setgeminikey.sh not found (copy scripts/setgeminikey.example)"
   exit 1
fi
source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
npm run temporal:worker
