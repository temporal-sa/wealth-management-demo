#!/bin/bash
# Send compliance approval to an account opening on Temporal Cloud (settings in scripts/setcloudenv.sh).
# Usage: cloudsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ -z "$1" ]; then
  echo "You must specify a workflow ID"
  exit 1
fi
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in first."
  exit 1
fi
source ../../../../scripts/setcloudenv.sh
exec go run ../cmd/compliance "$1"
