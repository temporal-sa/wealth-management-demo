#!/bin/bash
# Start the codec server, so the Temporal UI can show claim-checked payloads. Needs Redis.
cd "$(dirname "$0")" || exit 1
[ -f ../../setclaimcheck.sh ] && source ../../setclaimcheck.sh
npm run --silent codec-server
