# Wealth Management API (TypeScript)

Exposes the Temporal chat workflow (`WealthManagementWorkflow`) over a small HTTP API, for the TypeScript AI
frameworks. The [web application](../../../frontend/README.md) uses it; you can also call it with curl.

It is the TypeScript counterpart of the [Python API](../../python/api/README.md), with the same endpoints, the
same required AI framework argument and the same `GET /config`. Both use only the shared Temporal contract (the
workflow and signal names as strings, plain JSON payloads, and the claim-check codec when enabled), so either one
serves the TypeScript frameworks. It is written with Express and uses the shared code in
[`src/typescript/common`](../common) for the Temporal client, the Redis event stream, the chaos flags and the
claim check. [`frameworks.ts`](frameworks.ts) lists the frameworks; [`server.ts`](server.ts) is the HTTP layer.

## Endpoints

All parameters are query parameters.

| Method | Path | Parameters | Purpose |
|---|---|---|---|
| GET | `/` | none | Health check |
| GET | `/config` | none | The AI framework the API serves: `framework`, `label`, `task_queue` and `workflow_id_prefix`. The web application names each chat workflow `<workflow_id_prefix><random>` |
| POST | `/start-workflow` | `workflow_id` | Start a `WealthManagementWorkflow` (chat) with that ID on the framework's task queue |
| POST | `/send-prompt` | `workflow_id`, `prompt` | Send a customer message (`process_user_message` signal) |
| GET | `/get-chat-history` | `workflow_id`, `from_index` (default 0) | Chat messages and status updates from Redis, starting at `from_index` |
| POST | `/end-chat` | `workflow_id` | End the chat (`end_workflow` signal) |
| GET | `/chaos` | none | Chaos flags and recently injected failures |
| POST | `/chaos` | `flag`, `enabled` (`true` or anything else for off) | Turn a chaos flag on or off. Flags: `tool_down`, `llm_down`, `llm_rate_limited`, `custodian_rejects`, `slow_saga`, `workflow_bug` |
| POST | `/chaos/reset` | none | Turn every chaos flag off and clear the failure log |

The API listens on http://127.0.0.1:8000 and allows CORS requests from the web application at
`http://localhost:3000` and `http://127.0.0.1:3000`.

## Prerequisites

* [Node.js 20+](https://nodejs.org/) and npm
* Temporal running (`temporal server start-dev` locally, or Temporal Cloud)
* [Redis](https://redis.io/) running (`REDIS_HOST` / `REDIS_PORT`, default `localhost:6379`), for the chat
  history, the chaos flags and the claim check
* An AI framework's worker running. Start the API for the same framework:

| AI framework | Start the API with | Task queue | Chat workflow IDs |
|---|---|---|---|
| [Vercel AI SDK](../vercel_ai/durable/README.md) | `./startlocalapi.sh vercel_ai` | `VAI-Supervisor` | `vai-temporal-agent-<random>` |

There is no default framework: without a valid one, the scripts stop and list every framework.
`TEMPORAL_TASK_QUEUE` and `CHAT_WORKFLOW_ID_PREFIX` override the framework's values. The API prints the
framework and task queue it uses when it starts.

## Install dependencies

The API is one of the TypeScript npm workspaces. From `src/typescript`:

```bash
npm install
```

## Start the API

Locally, from the repository root:

```bash
./src/typescript/api/startlocalapi.sh vercel_ai
```

For Temporal Cloud, with the settings in `scripts/setcloudenv.sh` (copy `scripts/setcloudenv.example`):

```bash
./src/typescript/api/startcloudapi.sh vercel_ai
```

Both scripts source `scripts/setclaimcheck.sh` if it exists (see the
[claim check](../vercel_ai/durable/README.md#set-up-claim-check-optional) setup) and log whether claim check is
enabled on startup.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AI_FRAMEWORK` | none (required) | The AI framework to serve; the start scripts set it from their argument |
| `CHAT_WORKFLOW_ID_PREFIX` | the framework's | Prefix the web application gives chat workflow IDs |
| `API_HOST` | `127.0.0.1` | Bind address |
| `API_PORT` | `8000` | Bind port |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | empty | API key for Temporal Cloud |
| `TEMPORAL_TLS_CLIENT_CERT_PATH`, `TEMPORAL_TLS_CLIENT_KEY_PATH` | empty | mTLS certificate and key for Temporal Cloud |
| `TEMPORAL_TASK_QUEUE` | the framework's | Task queue the chat workflow is started on (must match the worker) |
| `USE_CLAIM_CHECK` | `false` | Enable the claim-check payload codec (`true`, `1` or `yes`, any case) |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` | Redis (chat history, chaos flags, claim check) |

## Tests

From `src/typescript/api`:

```bash
npm test
```

They check the framework argument: a missing or unknown framework stops the start scripts with every valid
option, and each framework has the same task queue and workflow ID prefix as in the Python API.

## Smoke test

```bash
curl http://127.0.0.1:8000/config
curl -X POST 'http://127.0.0.1:8000/start-workflow?workflow_id=vai-temporal-agent-test1'
curl -X POST 'http://127.0.0.1:8000/send-prompt?workflow_id=vai-temporal-agent-test1&prompt=Who%20are%20my%20beneficiaries%3F'
curl -X POST 'http://127.0.0.1:8000/send-prompt?workflow_id=vai-temporal-agent-test1&prompt=123'
curl 'http://127.0.0.1:8000/get-chat-history?workflow_id=vai-temporal-agent-test1&from_index=0'
curl -X POST 'http://127.0.0.1:8000/end-chat?workflow_id=vai-temporal-agent-test1'
```

The chaos panel's endpoints:

```bash
curl http://127.0.0.1:8000/chaos
curl -X POST 'http://127.0.0.1:8000/chaos?flag=tool_down&enabled=true'
curl -X POST http://127.0.0.1:8000/chaos/reset
```
