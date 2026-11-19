#!/bin/bash
# Run the open-account workflow's three scenarios without the chat or the LLM
# (see run_open_account_workflow.py). Starts a local Python worker in the background
# for the activities (and, without an argument, the workflow too), without the
# agents (SKIP_AGENTS=True, so no OpenAI key), and stops it when the scenarios finish.
# Usage: startlocalopenaccount.sh [java | <open-account task queue>]
# With java, the workflow runs on this framework's PYAI-Supervisor-open-account: start the Java worker for
# this framework first (TEMPORAL_TASK_QUEUE=PYAI-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this framework's <task queue>-open-account, for the Java worker). ***"
fi
export SKIP_AGENTS=True
echo "Starting the worker and running the three scenarios for the open-account workflow."
uv run python -m durable.run_worker &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null; wait $WORKER_PID 2>/dev/null' EXIT
uv run python -m durable.run_open_account_workflow
