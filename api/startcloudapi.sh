#!/bin/bash
# Start the API for the web UI against Temporal Cloud, with the settings in setcloudenv.sh.
cd "$(dirname "$0")" || exit 1
if [ ! -f ../setcloudenv.sh ]; then
  echo "**** setcloudenv.sh not found. Copy src/temporal_supervisor/setcloudenv.example to the repository root as setcloudenv.sh and fill it in."
  exit 1
fi
[ -f ../setclaimcheck.sh ] && source ../setclaimcheck.sh
source ../setcloudenv.sh
npm run --silent api
