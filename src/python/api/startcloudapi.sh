#!/bin/bash
# Usage: startcloudapi.sh <ai-framework>
# ai-framework (required) picks which AI framework's chat workflows the API starts: openai_agents,
# pyai, strands_agents, google_adk, pure or vercel_ai. Without a valid one, the script stops and lists them all.
# It sets that framework's task queue and workflow ID prefix (see frameworks.py); TEMPORAL_TASK_QUEUE
# and CHAT_WORKFLOW_ID_PREFIX still override them. Other settings use their defaults if not set.
cd "$(dirname "$0")" || exit 1
uv run python -m api.frameworks "$(basename "$0")" "$1" || exit 2
export AI_FRAMEWORK="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh
uv run uvicorn api.main:app --reload
