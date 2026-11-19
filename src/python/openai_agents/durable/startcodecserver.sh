#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "****************************************"
echo "* Remember to start your Redis Server! *"
echo "****************************************"
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run python codec_server/codec_server.py
