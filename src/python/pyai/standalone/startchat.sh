#!/bin/bash
cd "$(dirname "$0")" || exit 1
source ../../../../scripts/setoaikey.sh
uv run python -m standalone.main
