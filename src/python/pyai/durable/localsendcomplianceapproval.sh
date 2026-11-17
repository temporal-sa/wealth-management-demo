#!/bin/bash
if [ -z "$1" ]; then
   echo "You must specify a workflow ID"
   exit 1
fi
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run python -m durable.run_send_compliance_approval --workflow-id "$1"
