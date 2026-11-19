#!/bin/bash
# Usage: startlocalworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this framework's PYAI-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this framework too (TEMPORAL_TASK_QUEUE=PYAI-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setoaikey.sh
# if you pass in a parameter, use that as the task queue
# for the Open Account workflow
source ../../../../scripts/setsplitworkflows.sh $1
uv run python -m durable.run_worker
