# Go API

There is no Go API. For now, the [Python API](../../python/api/README.md) serves the Go frameworks, as it serves
every framework: their chat workflows keep the shared Temporal contract, so it starts them and sends them signals
like any other framework's.

When a Go framework is imported, add it to `src/python/api/frameworks.py` (its task queue and chat workflow ID
prefix) so `./startlocalapi.sh <ai-framework>` serves it.
