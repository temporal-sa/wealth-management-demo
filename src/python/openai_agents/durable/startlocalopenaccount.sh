#!/bin/bash
# Run the open-account workflow's three scenarios without the chat or the LLM
# (see run_open_account_workflow.py). Starts a local Python worker in the background
# for the activities (and, without an argument, the workflow too), without the
# OpenAI Agents plugin (SKIP_OPENAI_PLUGIN=True), and stops it when the scenarios finish.
# Usage: startlocalopenaccount.sh [java | <open-account task queue>]
# With java, the workflow runs on this port's OAI-Supervisor-open-account: start the Java worker for
# this port first (TEMPORAL_TASK_QUEUE=OAI-Supervisor interop/open_account/java/startlocalworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
[ -f ../../../../scripts/setoaikey.sh ] && source ../../../../scripts/setoaikey.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this port's <task queue>-open-account, for the Java worker). ***"
fi
export SKIP_OPENAI_PLUGIN=True
# The worker builds an OpenAI client at import time, which needs a key even though this
# run never calls the model. Use a placeholder if none is set.
export OPENAI_API_KEY="${OPENAI_API_KEY:-not-used-by-open-account-scenarios}"
echo "Starting the worker and running the three scenarios for the open-account workflow."
uv run python run_worker.py &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null; wait $WORKER_PID 2>/dev/null' EXIT
uv run python run_open_account_workflow.py
