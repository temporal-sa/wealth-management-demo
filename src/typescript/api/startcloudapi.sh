#!/bin/bash
# Usage: startcloudapi.sh <ai-framework>
# Like startlocalapi.sh, connected to Temporal Cloud with the settings in scripts/setcloudenv.sh.
cd "$(dirname "$0")" || exit 1
npx ts-node frameworks.ts "$(basename "$0")" "$1" || exit 2
export AI_FRAMEWORK="$1"
if [ ! -f ../../../scripts/setcloudenv.sh ]; then
   echo "scripts/setcloudenv.sh not found (copy scripts/setcloudenv.example)"
   exit 1
fi
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh
npm start
