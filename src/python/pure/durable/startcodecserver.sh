#!/bin/bash
# Start the codec server on http://127.0.0.1:8081, so the Temporal UI can show claim-checked
# payloads. It reads them from the Redis in setclaimcheck.sh (REDIS_HOST / REDIS_PORT).
cd "$(dirname "$0")/.." || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
echo "Codec server for claim-checked payloads, using Redis at ${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}."
echo "In the Temporal UI (http://localhost:8233 or https://cloud.temporal.io), set the codec server to http://127.0.0.1:8081"
uv run python -m temporal_supervisor.codec_server
