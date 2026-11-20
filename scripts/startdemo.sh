#!/bin/bash
# Starts the demo for one or more AI frameworks in one terminal: each framework's worker, the API serving
# them all, and the web UI, which shows a tab for each framework.
#
# Usage: scripts/startdemo.sh [--cloud] <ai-framework>
#   <ai-framework>  one of openai_agents, pyai, strands_agents, google_adk, pure, vercel_ai, google_adk_ts,
#                   google_adk_go; several separated by commas (strands_agents,vercel_ai); or all
#   --cloud         connect to Temporal Cloud (scripts/setcloudenv.sh) instead of a local Temporal service
#
# Start Temporal (local) and Redis first; this script checks them but doesn't start them. It runs each
# framework's own start script (startlocalworker.sh or startcloudworker.sh), then the API's
# (startlocalapi.sh or startcloudapi.sh) and the web UI (npm start). A framework whose model key file
# (scripts/set*key.sh) is missing is skipped. Every line of output is prefixed with where it came from,
# and also saved to logs/<name>.log. Ctrl-C stops everything this script started.
#
# Not started here: the Java open-account worker (start a framework's worker with java and the Java worker
# yourself, see interop/open_account/java) and the codec server.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$(basename "$0")"
LOGS="$ROOT/logs"
API_PORT=8000
WEBUI_PORT=3000

die() { echo "*** $*" >&2; exit 1; }

cloud=false
if [ "$1" = "--cloud" ]; then cloud=true; shift; fi
[ $# -eq 1 ] || die "Usage: $SCRIPT [--cloud] <ai-framework>, where <ai-framework> is a framework, several separated by commas, or all"

# The frameworks named, checked by the API's own list (src/python/api/frameworks.py)
cd "$ROOT/src/python/api" || exit 1
uv run python -m api.frameworks "$SCRIPT" "$1" || exit 2
requested=$(uv run python -c "import sys; from api.frameworks import names; print(' '.join(names(sys.argv[1])))" "$1")

# A framework's worker folder and model key file
worker_dir() {
  case "$1" in
    openai_agents|pyai|strands_agents|google_adk|pure) echo "src/python/$1/durable" ;;
    vercel_ai) echo "src/typescript/vercel_ai/durable" ;;
    google_adk_ts) echo "src/typescript/google_adk/durable" ;;
    google_adk_go) echo "src/go/google_adk/scripts" ;;
  esac
}
key_file() {
  case "$1" in
    openai_agents|pyai) echo "setoaikey.sh" ;;
    pure) echo "setllmkey.sh" ;;
    *) echo "setgeminikey.sh" ;;
  esac
}

# ---- Checks: nothing starts unless they pass
if $cloud; then
  where=cloud
  [ -f "$ROOT/scripts/setcloudenv.sh" ] || die "scripts/setcloudenv.sh not found: copy scripts/setcloudenv.example and fill it in."
else
  where=local
  address="${TEMPORAL_ADDRESS:-localhost:7233}"
  if command -v temporal >/dev/null 2>&1; then
    temporal operator cluster health --address "$address" >/dev/null 2>&1 \
      || die "No Temporal service at $address. Start one first, for example: temporal server start-dev"
  else
    echo "*** The temporal CLI isn't installed, so this script can't check for Temporal at $address."
  fi
fi

# Redis, with the same settings the workers and the API use (scripts/setclaimcheck.sh may set them)
redis_problem=$(
  [ -f "$ROOT/scripts/setclaimcheck.sh" ] && source "$ROOT/scripts/setclaimcheck.sh" >/dev/null
  uv run python -c "
from common.redis_config import RedisConfig
config = RedisConfig()
try:
    config.sync_client().ping()
except Exception as e:
    print(f'{config.address()}: {e}')
" 2>&1)
[ -z "$redis_problem" ] || die "Can't reach Redis ($redis_problem). Start it first, for example: redis-server"

for port in $API_PORT $WEBUI_PORT; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    die "Port $port is in use (the API uses $API_PORT, the web UI $WEBUI_PORT). Stop what's using it first."
  fi
done

[ -d "$ROOT/frontend/node_modules" ] || die "The web UI's dependencies aren't installed: cd frontend && npm install"

frameworks=""
for name in $requested; do
  if [ ! -f "$ROOT/scripts/$(key_file "$name")" ]; then
    echo "*** Skipping $name: scripts/$(key_file "$name") not found (copy scripts/$(key_file "$name" | sed 's/\.sh$/.example/'))."
    continue
  fi
  case "$name" in
    vercel_ai|google_adk_ts)
      [ -d "$ROOT/src/typescript/node_modules" ] || die "The TypeScript frameworks' dependencies aren't installed: cd src/typescript && npm install" ;;
  esac
  frameworks="$frameworks $name"
done
frameworks="${frameworks# }"
[ -n "$frameworks" ] || die "No framework left to start."

# ---- Start everything
mkdir -p "$LOGS"
pids=""

# run <name> <folder> <command...>: runs the command in the folder, its output prefixed with [name] and saved
# to logs/<name>.log (replaced on each run)
run() {
  local name=$1 dir=$2; shift 2
  (
    cd "$ROOT/$dir" || exit 1
    "$@" 2>&1 | tee "$LOGS/$name.log" | awk -v p="[$name] " '{ print p $0; fflush() }'
    echo "[$name] *** stopped (exit status ${PIPESTATUS[0]})"
  ) &
  pids="$pids $!"
}

killtree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do killtree "$child"; done
  kill "$1" 2>/dev/null
}

stopping=false
stop_all() {
  $stopping && return
  stopping=true
  echo
  echo "*** Stopping everything this script started..."
  for pid in $pids; do killtree "$pid"; done
  wait 2>/dev/null
  echo "*** Stopped."
}
trap 'stop_all; exit 0' INT TERM
trap stop_all EXIT

echo "*** Starting ($where): ${frameworks// /, }. Output is also in logs/. Ctrl-C stops everything."
for name in $frameworks; do
  run "$name" "$(worker_dir "$name")" "./start${where}worker.sh"
done
run api src/python/api "./start${where}api.sh" "${frameworks// /,}"
run webui frontend env PORT=$WEBUI_PORT npm start
echo "*** The web UI opens at http://localhost:$WEBUI_PORT once it has compiled."

wait
