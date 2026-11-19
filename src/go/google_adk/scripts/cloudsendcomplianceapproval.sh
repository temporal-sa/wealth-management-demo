#!/bin/bash
# Send compliance approval to an account opening on Temporal Cloud (settings in setcloudenv.sh).
# Usage: cloudsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
if [ -z "$1" ]; then
  echo "You must specify a workflow ID"
  exit 1
fi
if [ ! -f ../setcloudenv.sh ]; then
  echo "Copy setcloudenv.example to setcloudenv.sh and fill it in first."
  exit 1
fi
source ../setcloudenv.sh
exec go run ../cmd/compliance "$1"
