#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: startcloudworker.sh [open-account-task-queue]
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ./_cloudenv.sh
[ -f ../../../../scripts/setllmkey.sh ] && source ../../../../scripts/setllmkey.sh
# With a task queue name, the open-account workflow runs on that queue instead.
source ../../../../scripts/setsplitworkflows.sh "$1"
uv run python run_worker.py
