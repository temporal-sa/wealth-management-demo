# Go API

There is no Go API. For now, the [Python API](../../python/api/README.md) serves the Go ports, as it serves
every port: their chat workflows keep the shared Temporal contract, so it starts them and sends them signals
like any other port's.

When a Go port is imported, add it to `src/python/api/frameworks.py` (its task queue and chat workflow ID
prefix) so `./startlocalapi.sh <ai-framework>` serves it.
