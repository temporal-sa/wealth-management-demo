#!/bin/bash
# Send compliance approval to an open-account workflow on Temporal Cloud.
# Usage: cloudsendcomplianceapproval.sh <workflow-id>
if [ -z "$1" ]; then
   echo "You must specify a workflow ID"
   exit 1
fi
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
   echo "scripts/setcloudenv.sh not found (copy scripts/setcloudenv.example)"
   exit 1
fi
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
npm run compliance.approval -- --workflow-id "$1"
