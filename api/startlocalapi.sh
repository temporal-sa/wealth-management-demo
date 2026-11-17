#!/bin/bash
# Start the API for the web UI, at http://127.0.0.1:8000, against a local Temporal service.
cd "$(dirname "$0")" || exit 1
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
npm run --silent api
