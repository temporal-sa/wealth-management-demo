#!/bin/bash
# Usage: startcloudapi.sh [port]
# port picks which port's chat workflows the API starts: openai_agents (default), pyai or
# strands_agents.
# It sets that port's task queue and workflow ID prefix (see ports.py); TEMPORAL_TASK_QUEUE
# and CHAT_WORKFLOW_ID_PREFIX still override them. Other settings use their defaults if not set.
cd "$(dirname "$0")" || exit 1
[ -n "$1" ] && export CHAT_PORT="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh
uv run uvicorn api.main:app --reload
