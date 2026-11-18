#!/bin/bash
# Start the standalone command-line chat (no Temporal).
cd "$(dirname "$0")/.." || exit 1
[ -f ../../../scripts/setllmkey.sh ] && source ../../../scripts/setllmkey.sh
uv run python -m standalone.main
