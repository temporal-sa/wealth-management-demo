#!/bin/bash
# Start the claim-check codec server, so the Temporal UI can decode claim-checked payloads.
# It listens on http://127.0.0.1:8081; set that as the codec server in the Temporal UI.
cd "$(dirname "$0")" || exit 1
echo "****************************************"
echo "* Remember to start your Redis Server! *"
echo "****************************************"
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
exec go run ../cmd/codecserver
