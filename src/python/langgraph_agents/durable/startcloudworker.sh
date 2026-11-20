#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this framework's LangGraph-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this framework too (TEMPORAL_TASK_QUEUE=LangGraph-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ./_cloudenv.sh
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python run_worker.py
