#!/bin/bash
# Usage: startcloudapi.sh <ai-framework>
# ai-framework (required) picks which AI frameworks' chat workflows the API starts: openai_agents,
# pyai, strands_agents, google_adk, pure, vercel_ai, google_adk_ts or google_adk_go, several separated by
# commas (strands_agents,vercel_ai), or all. The web UI lists them in its sidebar. Without a valid value, the
# script stops and lists them all. It sets each framework's task queue and workflow ID prefix (see
# frameworks.py); with one framework, TEMPORAL_TASK_QUEUE and CHAT_WORKFLOW_ID_PREFIX still override them.
# Other settings use their defaults if not set.
cd "$(dirname "$0")" || exit 1
uv run python -m api.frameworks "$(basename "$0")" "$1" || exit 2
export AI_FRAMEWORK="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh
uv run uvicorn api.main:app --reload
