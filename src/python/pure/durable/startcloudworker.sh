#!/bin/bash
# Start the worker against Temporal Cloud (settings in setcloudenv.sh in the repository root).
# Usage: startcloudworker.sh [open-account-task-queue]
cd "$(dirname "$0")" || exit 1
[ -f ../../setclaimcheck.sh ] && source ../../setclaimcheck.sh
source ./_cloudenv.sh
[ -f ../../setllmkey.sh ] && source ../../setllmkey.sh
# With a task queue name, the open-account workflow runs on that queue instead.
source ../../setsplitworkflows.sh "$1"
uv run python run_worker.py
