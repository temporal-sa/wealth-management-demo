#!/bin/bash
# Start the worker against Temporal Cloud, with the settings in scripts/setcloudenv.sh
# (copy scripts/setcloudenv.example).
# Usage: startcloudworker.sh [open-account task queue]
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "**** setcloudenv.sh not found. Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in."
  exit 1
fi
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** The open-account workflow runs on task queue $1: start the Java worker on it. ***"
fi
npm run --silent temporal:worker
