#!/bin/bash
#
# If you pass an optional argument to this script, the port's own
# worker runs the AI (chat) workflow and the Java worker runs the
# Open Account workflow on that task queue.
#
if [ ! -z "$1" ]
  then
    echo "*** Using $1 as the Task Queue for the Open Account workflow. ***"
    export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
    echo "*** Remember to also start the Java Workflow ***"
fi