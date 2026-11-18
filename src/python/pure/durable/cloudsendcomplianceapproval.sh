#!/bin/bash
# Send compliance approval to an account opening on Temporal Cloud, as a compliance officer would.
# Usage: cloudsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
[ -f ../../setclaimcheck.sh ] && source ../../setclaimcheck.sh
if [ -z "$1" ]; then
   echo "You must specify a workflow ID"
   exit 1
fi
source ./_cloudenv.sh
uv run python run_send_compliance_approval.py --workflow-id "$1"
