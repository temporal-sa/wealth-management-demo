#!/bin/bash
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setoaikey.sh
# if you pass in a parameter, use that as the task queue
# for the Open Account workflow
source ../../../../scripts/setsplitworkflows.sh $1
uv run python -m durable.run_worker
