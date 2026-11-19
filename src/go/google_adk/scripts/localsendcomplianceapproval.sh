#!/bin/bash
# Send compliance approval to an account opening.
# Usage: localsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
if [ -z "$1" ]; then
  echo "You must specify a workflow ID"
  exit 1
fi
exec go run ../cmd/compliance "$1"
