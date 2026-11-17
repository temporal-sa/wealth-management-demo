#!/bin/bash
source ../../../../scripts/setoaikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
# if you pass in a parameter, use that as the task queue
# for the Open Account workflow
source ../../../../scripts/setsplitworkflows.sh $1
uv run python run_worker.py