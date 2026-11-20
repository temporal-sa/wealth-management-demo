#!/bin/bash
# Starts the demo for one or more AI frameworks in one terminal: each framework's worker, the API serving
# them all, and the web UI, which lists them in its sidebar.
#
# Usage: scripts/startdemo.sh [--cloud] [--java] <ai-framework>
#   <ai-framework>  one of openai_agents, pyai, strands_agents, google_adk, pure, langgraph_agents, vercel_ai,
#                   google_adk_ts, google_adk_go; several separated by commas (strands_agents,vercel_ai); or all
#   --cloud         connect to Temporal Cloud (scripts/setcloudenv.sh) instead of a local Temporal service
#   --java          run the open-account workflow on the Java worker (interop/open_account/java): one Java worker
#                   per framework, on <its task queue>-open-account, named java-<ai-framework>. Needs a JDK.
#
# While it runs, from another terminal:
#   scripts/startdemo.sh stop <ai-framework>     stops that framework's worker (the rest keep running)
#   scripts/startdemo.sh start <ai-framework>    starts it again
#   scripts/startdemo.sh restart <ai-framework>  both, for example to load a code fix
# With --java, java-<ai-framework> names that framework's Java worker (for example restart java-strands_agents).
# The worker's output stays in the first terminal, and Ctrl-C there still stops everything.
#
# Start Temporal (local) and Redis first; this script checks them but doesn't start them. It runs each
# framework's own start script (startlocalworker.sh or startcloudworker.sh), then the API's
# (startlocalapi.sh or startcloudapi.sh) and the web UI (npm start). A framework whose model key file
# (scripts/set*key.sh) is missing is skipped. Every line of output is prefixed with where it came from,
# and also saved to logs/<name>.log. Ctrl-C stops everything this script started.
#
# Not started here: the codec server.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$(basename "$0")"
LOGS="$ROOT/logs"
API_PORT=8000
WEBUI_PORT=3000

die() { echo "*** $*" >&2; exit 1; }

# Kills a process, then its descendants (the parent first, so a worker's loop doesn't see its worker exit
# and report it while everything stops)
killtree() {
  local children
  children=$(pgrep -P "$1" 2>/dev/null)
  kill "$1" 2>/dev/null
  for child in $children; do killtree "$child"; done
}

# How a running startdemo.sh and the stop, start and restart commands talk: for each worker, the PID of
# its loop (<name>.loop), of the running worker (<name>.worker), and what was asked of it (<name>.request)
CONTROL="$LOGS/.control"

running_workers() {
  local file names=""
  for file in "$CONTROL"/*.loop; do
    [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null && names="$names $(basename "$file" .loop)"
  done
  echo "${names# }"
}

# control <stop|start|restart> <ai-framework>
control() {
  local action=$1 name=$2 loop worker up=false
  [ -n "$name" ] || die "Usage: $SCRIPT $action <ai-framework>"
  loop=$(cat "$CONTROL/$name.loop" 2>/dev/null)
  if [ -z "$loop" ] || ! kill -0 "$loop" 2>/dev/null; then
    local running; running=$(running_workers)
    [ -n "$running" ] || die "$SCRIPT isn't running. Start the demo first, for example: $SCRIPT all"
    die "$SCRIPT isn't running a worker for $name. It runs: ${running// /, }"
  fi
  worker=$(cat "$CONTROL/$name.worker" 2>/dev/null)
  [ -n "$worker" ] && kill -0 "$worker" 2>/dev/null && up=true
  case "$action" in
    stop)
      $up || die "$name's worker is already stopped. Start it with: $SCRIPT start $name"
      echo stop > "$CONTROL/$name.request"
      killtree "$worker"
      echo "*** Stopped $name's worker. Start it again with: $SCRIPT start $name" ;;
    start)
      $up && die "$name's worker is already running. To restart it: $SCRIPT restart $name"
      echo start > "$CONTROL/$name.request"
      echo "*** Starting $name's worker; its output is in the first terminal." ;;
    restart)
      if $up; then
        echo restart > "$CONTROL/$name.request"
        killtree "$worker"
      else
        echo start > "$CONTROL/$name.request"
      fi
      echo "*** Restarting $name's worker; its output is in the first terminal." ;;
  esac
}

case "$1" in
  stop|start|restart)
    [ $# -eq 2 ] || die "Usage: $SCRIPT $1 <ai-framework>"
    control "$1" "$2"
    exit $? ;;
esac

cloud=false
java=false
while [ $# -gt 1 ]; do
  case "$1" in
    --cloud) cloud=true ;;
    --java) java=true ;;
    *) break ;;
  esac
  shift
done
[ $# -eq 1 ] && [ "${1#--}" = "$1" ] || die "Usage: $SCRIPT [--cloud] [--java] <ai-framework>, where <ai-framework> is a framework, several separated by commas, or all; or $SCRIPT stop|start|restart <ai-framework> while it runs"

# The frameworks named, checked by the API's own list (src/python/api/frameworks.py)
cd "$ROOT/src/python/api" || exit 1
uv run python -m api.frameworks "$SCRIPT" "$1" || exit 2
requested=$(uv run python -c "import sys; from api.frameworks import names; print(' '.join(names(sys.argv[1])))" "$1")

# A framework's worker folder and model key file
worker_dir() {
  case "$1" in
    openai_agents|pyai|strands_agents|google_adk|pure|langgraph_agents) echo "src/python/$1/durable" ;;
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

# The Java open-account worker: each framework's task queue, which its Java worker serves, and one build up
# front, so the Java workers don't all compile at once
if $java; then
  command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1 \
    || die "--java needs a JDK (25, see interop/open_account/java/README.md), and java isn't on the PATH."
  queues=$(uv run python -c "import sys; from api.frameworks import FRAMEWORKS; print(' '.join(FRAMEWORKS[n].task_queue for n in sys.argv[1:]))" $frameworks)
  echo "*** Building the Java open-account worker..."
  (cd "$ROOT/interop/open_account/java" && ./gradlew -q classes) || die "The Java open-account worker didn't build (see above)."
fi

# ---- Start everything
# Output goes through a pipe (for the prefix and the log), so ask Python not to hold it back in a buffer
export PYTHONUNBUFFERED=1
mkdir -p "$LOGS"
rm -rf "$CONTROL"
mkdir -p "$CONTROL"
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

# run_worker <name> <folder> <command...>: like run, but in a loop that the stop, start and restart commands
# drive. When the worker stops, the loop waits for a start (asked for, or after the worker stopped by itself).
# The log keeps every run.
run_worker() {
  local name=$1 dir=$2; shift 2
  local request="$CONTROL/$name.request"
  : > "$LOGS/$name.log"
  (
    cd "$ROOT/$dir" || exit 1
    while :; do
      rm -f "$request"
      ( "$@" 2>&1 | tee -a "$LOGS/$name.log" | awk -v p="[$name] " '{ print p $0; fflush() }' ) &
      echo $! > "$CONTROL/$name.worker"
      wait $!
      status=$?
      rm -f "$CONTROL/$name.worker"
      # Ctrl-C reaches the worker too, and it may exit before this loop is stopped: stay quiet then
      [ -e "$CONTROL/stopping" ] && exit 0
      if [ ! -s "$request" ]; then sleep 1; [ -e "$CONTROL/stopping" ] && exit 0; fi
      case "$(cat "$request" 2>/dev/null)" in
        restart) echo "[$name] *** restarting"; continue ;;
        stop) echo "[$name] *** stopped. Start it again with: $SCRIPT start $name" ;;
        *) echo "[$name] *** stopped (exit status $status). Start it again with: $SCRIPT start $name" ;;
      esac
      rm -f "$request"
      until [ "$(cat "$request" 2>/dev/null)" = start ]; do sleep 1; done
      echo "[$name] *** starting"
    done
  ) &
  echo $! > "$CONTROL/$name.loop"
  pids="$pids $!"
}

stopping=false
stop_all() {
  $stopping && return
  stopping=true
  echo
  echo "*** Stopping everything this script started..."
  touch "$CONTROL/stopping"
  for pid in $pids; do killtree "$pid"; done
  wait 2>/dev/null
  rm -rf "$CONTROL"
  echo "*** Stopped."
}
trap 'stop_all; exit 0' INT TERM
trap stop_all EXIT

echo "*** Starting ($where): ${frameworks// /, }. Output is also in logs/. Ctrl-C stops everything."
echo "*** To stop, start or restart one framework's worker, from another terminal: $SCRIPT stop|start|restart <ai-framework>"
if $java; then
  # Every framework's worker reads this: it leaves the open-account workflow to <its task queue>-open-account
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT=java
  echo "*** The open-account workflow runs on the Java worker; to restart one: $SCRIPT restart java-<ai-framework>"
fi
for name in $frameworks; do
  run_worker "$name" "$(worker_dir "$name")" "./start${where}worker.sh"
done
if $java; then
  set -- $queues
  for name in $frameworks; do
    run_worker "java-$name" interop/open_account/java env TEMPORAL_TASK_QUEUE="$1" "./start${where}worker.sh"
    shift
  done
fi
run api src/python/api "./start${where}api.sh" "${frameworks// /,}"
run webui frontend env PORT=$WEBUI_PORT npm start
echo "*** The web UI opens at http://localhost:$WEBUI_PORT once it has compiled."

wait
