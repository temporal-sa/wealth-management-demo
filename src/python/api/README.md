# Wealth Management API

Exposes the Temporal chat workflow (`WealthManagementWorkflow`) with an easy to use API. The
[web application](../../../frontend/README.md) uses it; you can also call it with curl.

It is the one API in this repository: it serves every AI framework, in any language (Python, TypeScript, Go, Java or .NET), because their chat workflows keep the same contract. One running API can serve several frameworks at once, and the web application then lists them all in its sidebar. It uses only the Temporal contracts (the workflow and signal
names as strings, plain JSON payloads through the Pydantic data converter, and the claim-check codec
when enabled), never a framework's workflow class or framework plugin. The start scripts' required argument
(`AI_FRAMEWORK`) picks the AI frameworks: it sets the task queue each framework's worker listens on and the
prefix of its chat workflow IDs (see [`frameworks.py`](frameworks.py)). The Temporal calls are in
[`client.py`](client.py); [`main.py`](main.py) is the HTTP layer.

## Browser sessions

Several people can use one running API at once. On its first request, each browser gets a random session ID in an
httpOnly cookie, `wm_session`. The API picks every chat's workflow ID itself, carrying that session:
`<workflow_id_prefix>session-<session ID>-chat-<random>`. The endpoints that take a `workflow_id` answer 404 for a chat
of another session. The session also scopes the chaos flags and, with `DEMO_DATA_STORE=redis` on the workers, the sample
data: activities find it from their workflow ID ([`common/session_scope.py`](../common/session_scope.py)).

All routes are under `/api`. The web UI calls them on its own origin: the React dev server proxies `/api` to the API, so
the browser sends the cookie without any cross-origin setup. With curl, keep a session in a cookie jar (`-b`/`-c`).

Operations (all parameters are query parameters)

| Method | Endpoint | Parameters | Description |
|---|---|---|---|
| GET | `/` | | The built web app (`WEB_APP_DIR`, by default `frontend/build`) when it is there, as in the container image; otherwise a short JSON message |
| GET | `/api/health` | | 200 `{"status": "ok"}` when Redis answers, 503 when it doesn't (the hosted demo's smoke check). The workers are reported per framework by `/api/config` |
| GET | `/api/config` | | The AI frameworks the API serves, in order, and the build running: `{"build": ..., "frameworks": [...]}`. Each framework has `framework`, `label`, `language` (`Python`, `TypeScript`, `Go`, `Java` or `.NET`), `short_label` (its name within that language), `task_queue`, `workflow_id_prefix`, `available` (whether a worker polls its task queue) and `model` (the model that worker recorded at startup, or null; see below). `build` is `DEMO_BUILD`, or null when it isn't set |
| POST | `/api/start-workflow` | `framework` (optional when the API serves one) | Starts a chat workflow for this browser session on the framework's task queue. Returns `{"message": "Workflow started.", "workflow_id": <its ID>}`. 400 for a framework the API doesn't serve |
| POST | `/api/send-prompt` | `workflow_id`, `prompt` | Sends the customer's message to the workflow (`process_user_message` signal) |
| GET | `/api/get-chat-history` | `workflow_id`, `from_index` (default `0`) | Returns the conversation events (chat messages and account-opening status updates) stored in Redis, starting at `from_index` |
| POST | `/api/end-chat` | `workflow_id` | Sends the `end_workflow` signal |
| POST | `/api/approve-compliance` | `workflow_id` (the chat's) | Sends `compliance_approved` to the chat's running open-account workflows (IDs starting `OpenAccount-<workflow_id>-`) whose `get_current_state` is `Waiting Compliance Review`. Returns `{"approved": [<their workflow IDs>]}` |
| GET | `/api/chaos` | | This session's failure-injection flags and the failures they recently caused |
| POST | `/api/chaos` | `flag`, `enabled` (`true` / `false`) | Turns a flag on or off for this session. Flags: `tool_down`, `llm_down`, `llm_rate_limited`, `custodian_rejects`, `slow_saga`, `workflow_bug`. With `DEMO_HOSTED=true`, `workflow_bug` is left out of `GET /api/chaos` and turning it on answers 400: on a hosted copy nobody can fix the workflow code and restart its worker |
| POST | `/api/chaos/reset` | | Turns every flag off and clears the failure log, for this session |

The endpoints that take a `workflow_id` answer 404 unless it is one of this session's chats. They need no framework:
the chat's workflow ID starts with its framework's prefix.

**Models and the build in the sidebar.** At startup every framework's worker records the model it uses (its
`GEMINI_MODEL`, `OPENAI_MODEL` or `LLM_MODEL`, or the framework's default) in the Redis hash `worker-info`, under its
chat task queue, as JSON `{"model": ...}` ([`common/worker_info.py`](../common/worker_info.py), and the same in each
language). `/api/config` reports it only for a framework whose worker is polling, and the web UI shows it under the
framework's name. A worker that can't reach Redis runs on without it. `DEMO_BUILD` names the build running, shown at
the bottom of the sidebar: the hosted demo sets it to the platform's rollout version, which changes with every new
build and starts with the commit it was built from (`git-<commit>-i<hash>`). Unset (as locally), no build is shown.

## Prerequisites

* [uv](https://docs.astral.sh/uv/) - Python Dependency Management
* Temporal running (`temporal server start-dev` locally, or Temporal Cloud)
* [Redis](https://redis.io/downloads/) running (`REDIS_URL`, or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`; default `localhost:6379` without a password)
* An AI framework's worker running, for example the OpenAI Agents SDK's (`src/python/openai_agents/durable/startlocalworker.sh`
  or `startcloudworker.sh`). Start the API for the same framework:

| AI framework | Start the API with | Task queue | Chat workflow IDs |
|---|---|---|---|
| [OpenAI Agents SDK](../openai_agents/durable/README.md) | `./startlocalapi.sh openai_agents` | `OAI-Supervisor` | `oai-temporal-agent-session-<session>-chat-<random>` |
| [Pydantic AI](../pyai/durable/README.md) | `./startlocalapi.sh pyai` | `PYAI-Supervisor` | `pyai-temporal-agent-session-<session>-chat-<random>` |
| [Strands Agents](../strands_agents/durable/README.md) | `./startlocalapi.sh strands_agents` | `Strands-Supervisor` | `strands-temporal-agent-session-<session>-chat-<random>` |
| [Google ADK](../google_adk/durable/README.md) | `./startlocalapi.sh google_adk` | `ADK-Supervisor` | `adk-temporal-agent-session-<session>-chat-<random>` |
| [Pure Python (LiteLLM)](../pure/durable/README.md) | `./startlocalapi.sh pure` | `Pure-Supervisor` | `pure-temporal-agent-session-<session>-chat-<random>` |
| [LangGraph](../langgraph_agents/durable/README.md) | `./startlocalapi.sh langgraph_agents` | `LangGraph-Supervisor` | `langgraph-temporal-agent-session-<session>-chat-<random>` |
| [Vercel AI SDK (TypeScript)](../../typescript/vercel_ai/durable/README.md) | `./startlocalapi.sh vercel_ai` | `VAI-Supervisor` | `vai-temporal-agent-session-<session>-chat-<random>` |
| [Google ADK (TypeScript)](../../typescript/google_adk/durable/README.md) | `./startlocalapi.sh google_adk_ts` | `ADK-TS-Supervisor` | `adk-ts-temporal-agent-session-<session>-chat-<random>` |
| [Strands Agents (TypeScript)](../../typescript/strands_agents/durable/README.md) | `./startlocalapi.sh strands_agents_ts` | `Strands-TS-Supervisor` | `strands-ts-temporal-agent-session-<session>-chat-<random>` |
| [OpenAI Agents SDK (TypeScript)](../../typescript/openai_agents/durable/README.md) | `./startlocalapi.sh openai_agents_ts` | `OAI-TS-Supervisor` | `oai-ts-temporal-agent-session-<session>-chat-<random>` |
| [Microsoft Agent Framework (.NET)](../../dotnet/agent_framework/docs/temporal.md), experimental: not in `all` | `./startlocalapi.sh agent_framework_dotnet` | `MAF-Supervisor` | `maf-temporal-agent-session-<session>-chat-<random>` |
| [Google ADK (Go)](../../go/google_adk/docs/temporal.md) | `./startlocalapi.sh google_adk_go` | `ADK-Go-Supervisor` | `adk-go-temporal-agent-session-<session>-chat-<random>` |
| [Spring AI (Java)](../../java/spring_ai/docs/temporal.md) | `./startlocalapi.sh spring_ai` | `SpringAI-Supervisor` | `springai-temporal-agent-session-<session>-chat-<random>` |

There is no default framework: without a valid one, the scripts stop and list every framework.
`TEMPORAL_TASK_QUEUE` and `CHAT_WORKFLOW_ID_PREFIX` override the framework's values. The API prints the
framework, queue and prefix it uses when it starts.

### Several frameworks at once

Give the scripts several frameworks separated by commas, or `all` (which leaves out the experimental frameworks; name one to serve it):

```bash
./startlocalapi.sh strands_agents,vercel_ai,google_adk_go
./startlocalapi.sh all
```

Or start the workers, the API and the web UI together with
[`scripts/startdemo.sh`](../../../scripts/README.md#start-the-demo-with-one-command), for example
`scripts/startdemo.sh strands_agents,vercel_ai,google_adk_go`.

The web application then lists them in its sidebar, grouped by language, and each keeps its own live chat, so you can
put the same questions to several frameworks and switch between them. Start each framework's worker as its README says; they
can all run against one Temporal service, because each has its own task queue. A framework with no worker
polling its task queue is greyed out and can't start a chat. Temporal keeps listing a stopped worker for a few minutes,
so it stays available for a while.

All the chats are one browser session: a chaos flag affects every framework's chat, and every chat sees the same sample
data, so an account opened in one framework's chat shows up in the others. With several frameworks, `TEMPORAL_TASK_QUEUE` and
`CHAT_WORKFLOW_ID_PREFIX` are ignored, because they would give every framework the same queue and prefix.

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
Be sure to have created scripts/setcloudenv.sh. See the [Temporal README](../openai_agents/durable/README.md#running-on-temporal-cloud) for more details.
```bash
cd src/python/api
./startcloudapi.sh openai_agents   # or pyai, strands_agents, google_adk, pure, langgraph_agents, vercel_ai, google_adk_ts, google_adk_go, spring_ai, strands_agents_ts, openai_agents_ts, agent_framework_dotnet
```

Test that the API is running:
```bash
curl http://127.0.0.1:8000
```

Start a workflow. The cookie jar (`-b`/`-c`) keeps your session for the calls that follow; the response gives the
chat's workflow ID. When the API serves several frameworks, name one (`?framework=pyai`):
```bash
curl -b /tmp/wm-cookies -c /tmp/wm-cookies -X POST 'http://127.0.0.1:8000/api/start-workflow'
```

Send a prompt
```bash
curl -b /tmp/wm-cookies -X POST 'http://127.0.0.1:8000/api/send-prompt?workflow_id=<your-workflow-id>&prompt=Who%20are%20my%20beneficiaries%3F'
```

Respond with a client ID
```bash
curl -b /tmp/wm-cookies -X POST 'http://127.0.0.1:8000/api/send-prompt?workflow_id=<your-workflow-id>&prompt=123'
```

Ask about investment accounts
```bash
curl -b /tmp/wm-cookies -X POST 'http://127.0.0.1:8000/api/send-prompt?workflow_id=<your-workflow-id>&prompt=What%20investment%20accounts%20do%20I%20have%3F'
```

Get the chat history
```bash
curl -b /tmp/wm-cookies "http://127.0.0.1:8000/api/get-chat-history?workflow_id=<your-workflow-id>&from_index=0"
```

Turn a chaos flag on, list the flags, and turn them all off (for this session)
```bash
curl -b /tmp/wm-cookies -X POST 'http://127.0.0.1:8000/api/chaos?flag=tool_down&enabled=true'
curl -b /tmp/wm-cookies http://127.0.0.1:8000/api/chaos
curl -b /tmp/wm-cookies -X POST http://127.0.0.1:8000/api/chaos/reset
```

Approve the compliance review of the chat's account openings that wait for it
```bash
curl -b /tmp/wm-cookies -X POST "http://127.0.0.1:8000/api/approve-compliance?workflow_id=<your-workflow-id>"
```

End the Chat
```bash
curl -b /tmp/wm-cookies -X POST "http://127.0.0.1:8000/api/end-chat?workflow_id=<your-workflow-id>"
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
