#!/bin/bash
# Start the standalone command-line chat (no Temporal).
cd "$(dirname "$0")/.." || exit 1
[ -f ../../../scripts/setoaikey.sh ] && source ../../../scripts/setoaikey.sh
export DOTNET_CLI_TELEMETRY_OPTOUT=1
exec dotnet run --project Standalone
