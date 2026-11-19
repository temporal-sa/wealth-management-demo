#!/bin/bash
#
# Sourced by the worker scripts with their optional argument.
#   java            the open-account workflow runs on this port's own <task queue>-open-account,
#                   for the Java worker (start it with TEMPORAL_TASK_QUEUE set to this port's queue)
#   <queue name>    the open-account workflow runs on that queue
# Without an argument, the port's own worker runs it. The port's code turns "java" into the queue
# name (see common/task_queues.py, common/task-queues.ts or the Go port's config).
#
if [ -n "$1" ]
  then
    export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
    if [ "$(echo "$1" | tr '[:upper:]' '[:lower:]')" = "java" ]; then
      echo "*** The open-account workflow runs on this port's <task queue>-open-account. ***"
      echo "*** Start the Java worker with TEMPORAL_TASK_QUEUE set to this port's task queue. ***"
    else
      echo "*** Using $1 as the task queue for the open-account workflow: start the worker that polls it. ***"
    fi
fi
