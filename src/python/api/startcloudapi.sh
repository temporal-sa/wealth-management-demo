#!/bin/bash
# Usage: startcloudapi.sh <port>
# port (required) picks which port's chat workflows the API starts: openai_agents, pyai,
# strands_agents or google_adk. Without a valid one, the script stops and lists them all.
# It sets that port's task queue and workflow ID prefix (see ports.py); TEMPORAL_TASK_QUEUE
# and CHAT_WORKFLOW_ID_PREFIX still override them. Other settings use their defaults if not set.
cd "$(dirname "$0")" || exit 1
uv run python -m api.ports "$(basename "$0")" "$1" || exit 2
export CHAT_PORT="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh
uv run uvicorn api.main:app --reload
