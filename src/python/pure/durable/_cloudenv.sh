# Sourced by the cloud scripts: loads the Temporal Cloud settings from setcloudenv.sh in the
# repository root, or stops with instructions if it doesn't exist.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ ! -f "$_root/setcloudenv.sh" ]; then
   echo "setcloudenv.sh not found. From the repository root, run:"
   echo "  cp setcloudenv.example setcloudenv.sh"
   echo "then edit it for your Temporal Cloud namespace."
   exit 1
fi
source "$_root/setcloudenv.sh"
echo "Connecting to Temporal Cloud: ${TEMPORAL_ADDRESS} (namespace ${TEMPORAL_NAMESPACE})"
