#!/bin/bash
# Send compliance approval to an open-account workflow, locally.
# Usage: localsendcomplianceapproval.sh <workflow-id>
if [ -z "$1" ]; then
   echo "You must specify a workflow ID"
   exit 1
fi
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
npm run compliance.approval -- --workflow-id "$1"
