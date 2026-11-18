#!/bin/bash
# Usage: startlocalapi.sh <ai-framework>
# ai-framework (required) picks which TypeScript AI framework's chat workflows the API starts:
# vercel_ai. Without a valid one, the script stops and lists them all. It sets that framework's
# task queue and workflow ID prefix (see frameworks.ts); TEMPORAL_TASK_QUEUE and
# CHAT_WORKFLOW_ID_PREFIX still override them. Other settings use their defaults if not set.
cd "$(dirname "$0")" || exit 1
npx ts-node frameworks.ts "$(basename "$0")" "$1" || exit 2
export AI_FRAMEWORK="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
npm start
