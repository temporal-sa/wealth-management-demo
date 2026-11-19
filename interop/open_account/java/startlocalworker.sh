#!/bin/bash
# Starts the Java open-account worker against a local Temporal service.
# Usage: TEMPORAL_TASK_QUEUE=<framework's task queue> ./startlocalworker.sh [open-account task queue]
# TEMPORAL_TASK_QUEUE (required) is the task queue of the framework whose account openings this worker
# runs, for example OAI-Supervisor. The workflow then runs on <TEMPORAL_TASK_QUEUE>-open-account,
# where that framework starts it when its worker script gets the argument java. An argument names
# another open-account queue instead.
cd "$(dirname "$0")" || exit 1
if [ -z "$TEMPORAL_TASK_QUEUE" ]; then
  echo "**** Set TEMPORAL_TASK_QUEUE to the task queue of the framework this worker serves, for example:"
  echo "  TEMPORAL_TASK_QUEUE=OAI-Supervisor $0"
  echo "Each framework's queue is listed in interop/open_account/java/README.md."
  exit 1
fi
[ -n "$1" ] && export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
echo "*** Open-account workflow on ${TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT:-$TEMPORAL_TASK_QUEUE-open-account}, calling the activities on $TEMPORAL_TASK_QUEUE"
# Spring reads a Redis URL as SPRING_DATA_REDIS_URL; it wins over REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
[ -n "$REDIS_URL" ] && export SPRING_DATA_REDIS_URL="$REDIS_URL"
./gradlew runWorker
