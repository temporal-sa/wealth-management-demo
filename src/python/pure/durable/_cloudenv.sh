# Sourced by the cloud scripts: loads the Temporal Cloud settings from scripts/setcloudenv.sh,
# or stops with instructions if it doesn't exist.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if [ ! -f "$_root/scripts/setcloudenv.sh" ]; then
   echo "scripts/setcloudenv.sh not found. From the repository root, run:"
   echo "  cp scripts/setcloudenv.example scripts/setcloudenv.sh"
   echo "then edit it for your Temporal Cloud namespace."
   exit 1
fi
source "$_root/scripts/setcloudenv.sh"
echo "Connecting to Temporal Cloud: ${TEMPORAL_ADDRESS} (namespace ${TEMPORAL_NAMESPACE})"
