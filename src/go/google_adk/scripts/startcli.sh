#!/bin/bash
# Start the standalone command-line chat (Google ADK alone, no Temporal).
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
exec go run ../cmd/cli
