#!/bin/bash
# uses default values if environment variables are not set.
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
uv run uvicorn api.main:app --reload