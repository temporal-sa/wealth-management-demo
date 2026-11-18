#!/bin/bash
# Start the claim-check codec server, so the Temporal UI can show the payloads stored
# in Redis. Reads REDIS_HOST / REDIS_PORT from scripts/setclaimcheck.sh.
cd "$(dirname "$0")" || exit 1
echo "****************************************"
echo "* Remember to start your Redis Server! *"
echo "****************************************"
if [ ! -f ../../../../scripts/setclaimcheck.sh ]; then
   echo "The codec server needs scripts/setclaimcheck.sh (copy scripts/setclaimcheck.example)"
   exit 1
fi
source ../../../../scripts/setclaimcheck.sh
uv run python -m durable.codec_server.codec_server
