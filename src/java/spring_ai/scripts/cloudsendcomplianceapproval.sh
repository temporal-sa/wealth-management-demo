#!/bin/bash
# Send compliance approval to an account opening on Temporal Cloud (settings in scripts/setcloudenv.sh, which
# the temporal CLI reads: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TEMPORAL_API_KEY or the TLS settings).
# Usage: cloudsendcomplianceapproval.sh <open-account workflow ID>
cd "$(dirname "$0")" || exit 1
if [ -z "$1" ]; then
  echo "You must specify a workflow ID"
  exit 1
fi
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in first."
  exit 1
fi
source ../../../../scripts/setcloudenv.sh
exec temporal workflow signal --workflow-id "$1" --name compliance_approved
