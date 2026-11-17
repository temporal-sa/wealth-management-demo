#!/bin/bash
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
source ../../../../scripts/setcloudenv.sh
uv run uvicorn api.main:app --reload