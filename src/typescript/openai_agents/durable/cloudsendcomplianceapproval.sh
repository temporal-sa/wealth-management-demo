#!/bin/bash
# Send compliance_approved to an open-account workflow on Temporal Cloud.
# Usage: cloudsendcomplianceapproval.sh <workflow ID>
cd "$(dirname "$0")" || exit 1
if [ -z "$1" ]; then
  echo "Usage: $0 <workflow ID>"
  exit 1
fi
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "**** setcloudenv.sh not found. Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in."
  exit 1
fi
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
npm run --silent compliance.approval -- --workflow-id "$1"
