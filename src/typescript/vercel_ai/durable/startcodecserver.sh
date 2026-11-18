#!/bin/bash
# Start the claim check codec server, so the Temporal UI can show claim-checked payloads.
cd "$(dirname "$0")" || exit 1
echo "****************************************"
echo "* Remember to start your Redis Server! *"
echo "****************************************"
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
npm run codec-server
