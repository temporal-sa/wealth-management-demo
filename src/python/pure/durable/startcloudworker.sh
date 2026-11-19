#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this port's Pure-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this port too (TEMPORAL_TASK_QUEUE=Pure-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ./_cloudenv.sh
[ -f ../../../../scripts/setllmkey.sh ] && source ../../../../scripts/setllmkey.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python run_worker.py
