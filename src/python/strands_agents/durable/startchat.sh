#!/bin/bash
# Start the interactive CLI chat client.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run python -m durable.run_chat
