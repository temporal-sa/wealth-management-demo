#!/bin/bash
# Start the worker against a local Temporal dev server (127.0.0.1:7233).
# Usage: startlocalworker.sh [open-account-task-queue]
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
[ -f ../../../../scripts/setllmkey.sh ] && source ../../../../scripts/setllmkey.sh
# With a task queue name, the open-account workflow runs on that queue instead.
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python run_worker.py
