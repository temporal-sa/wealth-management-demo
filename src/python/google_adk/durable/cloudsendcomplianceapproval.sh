#!/bin/bash
# Send the compliance-approved signal to an open-account child workflow on
# Temporal Cloud (settings from scripts/setcloudenv.sh).
# Usage: ./cloudsendcomplianceapproval.sh <child-workflow-id>
if [ -z "$1" ]; then
   echo "You must specify a workflow ID"
   exit 1
fi
cd "$(dirname "$0")" || exit 1
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
   echo "scripts/setcloudenv.sh not found (copy scripts/setcloudenv.example)"
   exit 1
fi
source ../../../../scripts/setcloudenv.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run python -m durable.run_send_compliance_approval --workflow-id "$1"
