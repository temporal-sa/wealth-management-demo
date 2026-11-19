#!/bin/bash
# Starts the Java Open Account worker against Temporal Cloud, with an API key or mTLS, using the connection
# settings in ../../../scripts/setcloudenv.sh (see scripts/setcloudenv.example) and the claim check
# settings in ../../../scripts/setclaimcheck.sh.
# Usage: TEMPORAL_TASK_QUEUE=<framework's task queue> ./startcloudworker.sh [open-account task queue]
# TEMPORAL_TASK_QUEUE (required) is the task queue of the framework whose account openings this worker
# runs. The workflow runs on <TEMPORAL_TASK_QUEUE>-open-account, where that framework starts it when its
# cloud worker script gets the argument java. An argument names another open-account queue instead.
cd "$(dirname "$0")" || exit 1
if [ -z "$TEMPORAL_TASK_QUEUE" ]; then
  echo "**** Set TEMPORAL_TASK_QUEUE to the task queue of the framework this worker serves, for example:"
  echo "  TEMPORAL_TASK_QUEUE=OAI-Supervisor $0"
  echo "Each framework's queue is listed in interop/open_account/java/README.md."
  exit 1
fi
[ -n "$1" ] && export TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT="$1"

if [ ! -f ../../../scripts/setcloudenv.sh ]; then
  echo "**** ../../../scripts/setcloudenv.sh not found. Copy scripts/setcloudenv.example to"
  echo "scripts/setcloudenv.sh and fill in your Temporal Cloud details."
  exit 1
fi
[ -f ../../../scripts/setclaimcheck.sh ] && source ../../../scripts/setclaimcheck.sh
source ../../../scripts/setcloudenv.sh

for var in TEMPORAL_ADDRESS TEMPORAL_NAMESPACE; do
  if [ -z "${!var}" ]; then
    echo "**** $var is not set. Check ../../../scripts/setcloudenv.sh."
    exit 1
  fi
done

if [ -n "$TEMPORAL_API_KEY" ]; then
  # An API key: the Spring profile tc-apikey (application-tc-apikey.yaml)
  export SPRING_PROFILES_ACTIVE=tc-apikey
  AUTH="API key"
else
  # mTLS: map the settings in setcloudenv.sh to the names the Java worker reads
  # (common/ServerInfo.java for the activity client, application-tc.yaml for the worker).
  export TEMPORAL_CERT_PATH="${TEMPORAL_CERT_PATH:-$TEMPORAL_TLS_CLIENT_CERT_PATH}"
  KEY_PATH="${TEMPORAL_KEY_PKCS8_PATH:-${TEMPORAL_KEY_PATH:-$TEMPORAL_TLS_CLIENT_KEY_PATH}}"
  if [ -z "$TEMPORAL_CERT_PATH" ] || [ -z "$KEY_PATH" ]; then
    echo "**** Set either TEMPORAL_API_KEY, or TEMPORAL_TLS_CLIENT_CERT_PATH and TEMPORAL_TLS_CLIENT_KEY_PATH,"
    echo "in ../../../scripts/setcloudenv.sh."
    exit 1
  fi
  for file in "$TEMPORAL_CERT_PATH" "$KEY_PATH"; do
    if [ ! -r "$file" ]; then
      echo "**** Cannot read $file. Check the paths in ../../../scripts/setcloudenv.sh."
      exit 1
    fi
  done

  # Java's TLS needs the client key in unencrypted PKCS8 format (-----BEGIN PRIVATE KEY-----).
  # Keys from tcld or openssl are often PKCS1 (-----BEGIN RSA PRIVATE KEY-----) or SEC1 (EC).
  if ! grep -q -- "-----BEGIN PRIVATE KEY-----" "$KEY_PATH"; then
    PKCS8_PATH="${KEY_PATH%.*}.pkcs8.key"
    echo "**** The client key $KEY_PATH is not an unencrypted PKCS8 key, which the Java worker needs."
    echo "Convert it with:"
    echo ""
    echo "  openssl pkcs8 -topk8 -nocrypt -in \"$KEY_PATH\" -out \"$PKCS8_PATH\""
    echo ""
    echo "then add this line to ../../../scripts/setcloudenv.sh (the Python worker keeps using TEMPORAL_TLS_CLIENT_KEY_PATH):"
    echo ""
    echo "  export TEMPORAL_KEY_PKCS8_PATH=\"$PKCS8_PATH\""
    exit 1
  fi
  export TEMPORAL_KEY_PKCS8_PATH="$KEY_PATH"
  # The Temporal Cloud Spring profile with mTLS (application-tc.yaml)
  export SPRING_PROFILES_ACTIVE=tc
  AUTH="mTLS"
fi

echo "*** Connecting the Open Account worker to $TEMPORAL_NAMESPACE at $TEMPORAL_ADDRESS ($AUTH)"
echo "*** Open-account workflow on ${TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT:-$TEMPORAL_TASK_QUEUE-open-account}, calling the activities on $TEMPORAL_TASK_QUEUE"
# Spring reads a Redis URL as SPRING_DATA_REDIS_URL; it wins over REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
[ -n "$REDIS_URL" ] && export SPRING_DATA_REDIS_URL="$REDIS_URL"
./gradlew runWorker
