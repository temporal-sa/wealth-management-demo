# Wealth Management API

Exposes the Temporal chat workflow (`WealthManagementWorkflow`) with an easy to use API. The
[web application](../../../frontend/README.md) uses it; you can also call it with curl.

The API works with every Python AI framework in this repository, and with the TypeScript Vercel AI SDK port, whose chat workflows keep the same contract. It uses only the Temporal contracts (the workflow and signal
names as strings, plain JSON payloads through the Pydantic data converter, and the claim-check codec
when enabled), never a port's workflow class or framework plugin. The start scripts' required argument
(`AI_FRAMEWORK`) picks the AI framework: it sets the task queue that framework's worker listens on and the
prefix of its chat workflow IDs (see [`frameworks.py`](frameworks.py)). The Temporal calls are in
[`client.py`](client.py); [`main.py`](main.py) is the HTTP layer.

Operations (all parameters are query parameters)

| Method | Endpoint | Parameters | Description |
|---|---|---|---|
| GET | `/` | | Health check |
| GET | `/config` | | The AI framework the API serves: `framework`, `label`, `task_queue` and `workflow_id_prefix`. The web application names each chat workflow `<workflow_id_prefix><random>` |
| POST | `/start-workflow` | `workflow_id` | Starts a chat workflow with that ID on the port's task queue |
| POST | `/send-prompt` | `workflow_id`, `prompt` | Sends the customer's message to the workflow (`process_user_message` signal) |
| GET | `/get-chat-history` | `workflow_id`, `from_index` (default `0`) | Returns the conversation events (chat messages and account-opening status updates) stored in Redis, starting at `from_index` |
| POST | `/end-chat` | `workflow_id` | Sends the `end_workflow` signal |
| GET | `/chaos` | | The chaos panel's failure-injection flags and the failures they recently caused |
| POST | `/chaos` | `flag`, `enabled` (`true` / `false`) | Turns a flag on or off. Flags: `tool_down`, `llm_down`, `llm_rate_limited`, `custodian_rejects`, `slow_saga`, `workflow_bug` |
| POST | `/chaos/reset` | | Turns every flag off and clears the failure log |

CORS allows the web application at `http://localhost:3000` and `http://127.0.0.1:3000`.

## Prerequisites

* [uv](https://docs.astral.sh/uv/) - Python Dependency Management
* Temporal running (`temporal server start-dev` locally, or Temporal Cloud)
* [Redis](https://redis.io/downloads/) running (`REDIS_HOST` / `REDIS_PORT`, default `localhost:6379`)
* An AI framework's worker running, for example the OpenAI Agents SDK's (`src/python/openai_agents/durable/startlocalworker.sh`
  or `startcloudworker.sh`). Start the API for the same framework:

| AI framework | Start the API with | Task queue | Chat workflow IDs |
|---|---|---|---|
| [OpenAI Agents SDK](../openai_agents/durable/README.md) | `./startlocalapi.sh openai_agents` | `Supervisor` | `oai-temporal-agent-<random>` |
| [Pydantic AI](../pyai/durable/README.md) | `./startlocalapi.sh pyai` | `PY-AI-Supervisor` | `pyai-temporal-agent-<random>` |
| [Strands Agents](../strands_agents/durable/README.md) | `./startlocalapi.sh strands_agents` | `wealth-management-strands` | `strands-temporal-agent-<random>` |
| [Google ADK](../google_adk/durable/README.md) | `./startlocalapi.sh google_adk` | `ADK-Supervisor` | `adk-temporal-agent-<random>` |
| [Pure Python (LiteLLM)](../pure/durable/README.md) | `./startlocalapi.sh pure` | `Pure-Supervisor` | `pure-temporal-agent-<random>` |
| [Vercel AI SDK (TypeScript)](../../typescript/vercel_ai/durable/README.md) | `./startlocalapi.sh vercel_ai` | `VAI-Supervisor` | `vai-temporal-agent-<random>` |

There is no default framework: without a valid one, the scripts stop and list every framework.
`TEMPORAL_TASK_QUEUE` and `CHAT_WORKFLOW_ID_PREFIX` override the framework's values. The API prints the
framework, queue and prefix it uses when it starts.

See each framework's Temporal README (linked above) for setting these up.

## Set up Python Environment
The API has its own environment, with no agent framework installed. From the repository root:
```bash
cd src/python/api
uv sync
```

### Start API Server

The API listens on http://127.0.0.1:8000 (uvicorn's default, with `--reload`). Both scripts source
`scripts/setclaimcheck.sh` if it exists. Claim check is optional: without that file, the API runs
without it.

#### Connect locally
From the repository root:
```bash
cd src/python/api
./startlocalapi.sh openai_agents   # OpenAI Agents SDK
./startlocalapi.sh pyai            # Pydantic AI
```

#### Connect to Temporal Cloud
Be sure to have created scripts/setcloudenv.sh. See the [Temporal README](../openai_agents/durable/README.md#running-the-demo-in-temporal-cloud) for more details.
```bash
cd src/python/api
./startcloudapi.sh openai_agents   # or pyai, strands_agents, google_adk, pure, vercel_ai
```

Test that the API is running:
```bash
curl http://127.0.0.1:8000
```

Start a workflow:
```bash
curl -X POST 'http://127.0.0.1:8000/start-workflow?workflow_id=<your-workflow-id>'
```

Send a prompt
```bash
curl -X POST 'http://127.0.0.1:8000/send-prompt?workflow_id=<your-workflow-id>&prompt=Who%20are%20my%20beneficiaries%3F'
```

Respond with a client ID
```bash
curl -X POST 'http://127.0.0.1:8000/send-prompt?workflow_id=<your-workflow-id>&prompt=123'
```

Ask about investment accounts
```bash
curl -X POST 'http://127.0.0.1:8000/send-prompt?workflow_id=<your-workflow-id>&prompt=What%20investment%20accounts%20do%20I%20have%3F'
```

Get the chat history
```bash
curl "http://127.0.0.1:8000/get-chat-history?workflow_id=<your-workflow-id>&from_index=0"
```

Turn a chaos flag on, list the flags, and turn them all off
```bash
curl -X POST 'http://127.0.0.1:8000/chaos?flag=tool_down&enabled=true'
curl http://127.0.0.1:8000/chaos
curl -X POST http://127.0.0.1:8000/chaos/reset
```

End the Chat
```bash
curl -X POST "http://127.0.0.1:8000/end-chat?workflow_id=<your-workflow-id>"
```

## Tests

From the repository root:
```bash
cd src/python/api
uv run pytest
```

The tests call the endpoints over HTTP against a stub chat workflow on the Temporal test server
(downloaded automatically on first run), so no model key, Redis or running Temporal service is needed.
The stub's worker uses Temporal's default data converter, which shows the API's payloads are plain JSON
any framework's worker can read. Each Python framework also checks the API's calls against its real chat workflow, for
example `src/python/openai_agents/tests/test_api_client.py` and `src/python/pyai/tests/test_api_client.py`.
