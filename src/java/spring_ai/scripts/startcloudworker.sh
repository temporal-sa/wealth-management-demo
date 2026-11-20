#!/bin/bash
# Start the worker against Temporal Cloud (settings in scripts/setcloudenv.sh), with an API key or mTLS.
# Usage: startcloudworker.sh [java | <open-account task queue>]
# With java, the open-account workflow runs on this framework's SpringAI-Supervisor-open-account
# (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) and this worker doesn't run it: start the Java worker for
# this framework too (TEMPORAL_TASK_QUEUE=SpringAI-Supervisor interop/open_account/java/startcloudworker.sh).
# Another value names the queue.
cd "$(dirname "$0")" || exit 1
[ -f ../../../../scripts/setclaimcheck.sh ] && source ../../../../scripts/setclaimcheck.sh
if [ ! -f ../../../../scripts/setcloudenv.sh ]; then
  echo "Copy scripts/setcloudenv.example to scripts/setcloudenv.sh and fill it in first."
  exit 1
fi
[ -f ../../../../scripts/setgeminikey.sh ] && source ../../../../scripts/setgeminikey.sh
source ../../../../scripts/setcloudenv.sh
if [ -z "$TEMPORAL_API_KEY" ] && [ -n "$TEMPORAL_TLS_CLIENT_KEY_PATH" ] && [ -z "$TEMPORAL_KEY_PKCS8_PATH" ] \
    && ! grep -q -- "-----BEGIN PRIVATE KEY-----" "$TEMPORAL_TLS_CLIENT_KEY_PATH"; then
  # Java's TLS needs the client key in unencrypted PKCS8 format (-----BEGIN PRIVATE KEY-----)
  PKCS8_PATH="${TEMPORAL_TLS_CLIENT_KEY_PATH%.*}.pkcs8.key"
  echo "**** The client key $TEMPORAL_TLS_CLIENT_KEY_PATH is not an unencrypted PKCS8 key, which Java needs. Convert it:"
  echo ""
  echo "  openssl pkcs8 -topk8 -nocrypt -in \"$TEMPORAL_TLS_CLIENT_KEY_PATH\" -out \"$PKCS8_PATH\""
  echo ""
  echo "then add to scripts/setcloudenv.sh:  export TEMPORAL_KEY_PKCS8_PATH=\"$PKCS8_PATH\""
  exit 1
fi
echo "Connecting to Temporal Cloud: ${TEMPORAL_ADDRESS} (namespace ${TEMPORAL_NAMESPACE})"
if [ -n "$1" ]; then
  export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"
  echo "*** Open-account workflow on: $1 (java means this framework's <task queue>-open-account, for the Java worker). ***"
fi
[ -n "$REDIS_URL" ] && export SPRING_DATA_REDIS_URL="$REDIS_URL"
cd .. && exec ./gradlew -q runWorker
