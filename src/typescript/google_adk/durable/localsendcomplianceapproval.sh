#!/bin/bash
# Send compliance_approved to an open-account workflow, as a compliance officer would.
# Usage: localsendcomplianceapproval.sh <workflow ID>
cd "$(dirname "$0")" || exit 1
if [ -z "$1" ]; then
  echo "Usage: $0 <workflow ID>"
  exit 1
fi
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
npm run --silent compliance.approval -- --workflow-id "$1"
