#!/bin/bash
# Start the standalone command-line chat (no Temporal).
cd "$(dirname "$0")/.." || exit 1
[ -f ../setllmkey.sh ] && source ../setllmkey.sh
uv run python -m pure_supervisor.main
