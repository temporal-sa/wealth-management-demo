#!/bin/bash
# Start the claim-check codec server on http://127.0.0.1:8081, so the Temporal UI
# can show the payloads stored in Redis. Reads REDIS_HOST / REDIS_PORT (from
# scripts/setclaimcheck.sh, if it exists).
cd "$(dirname "$0")" || exit 1
echo "****************************************"
echo "* Remember to start your Redis Server! *"
echo "****************************************"
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run python -m durable.codec_server.codec_server
