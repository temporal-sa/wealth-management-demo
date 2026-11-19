#!/bin/bash
# Start the standalone command-line chat (Google ADK alone, no Temporal).
cd "$(dirname "$0")" || exit 1
[ -f ../setgeminikey.sh ] && source ../setgeminikey.sh
exec go run ../cmd/cli
