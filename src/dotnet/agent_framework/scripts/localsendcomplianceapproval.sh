#!/bin/bash
# Send compliance approval to an account opening (its compliance_approved signal, which has no payload).
# Usage: localsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
if [ -z "$1" ]; then
  echo "You must specify a workflow ID"
  exit 1
fi
exec temporal workflow signal --workflow-id "$1" --name compliance_approved
