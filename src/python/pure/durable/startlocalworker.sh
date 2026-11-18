#!/bin/bash
# Start the worker against a local Temporal dev server (127.0.0.1:7233).
# Usage: startlocalworker.sh [open-account-task-queue]
cd "$(dirname "$0")" || exit 1
[ -f ../../setclaimcheck.sh ] && source ../../setclaimcheck.sh
[ -f ../../setllmkey.sh ] && source ../../setllmkey.sh
# With a task queue name, the open-account workflow runs on that queue instead.
source ../../setsplitworkflows.sh "$1"
uv run python run_worker.py
