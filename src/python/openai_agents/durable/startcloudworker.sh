#!/bin/bash
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's OAI-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=OAI-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
source ../../../../scripts/setoaikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
# if you pass in a parameter, use that as the task queue
# for the Open Account workflow
source ../../../../scripts/setsplitworkflows.sh $1
uv run python run_worker.py