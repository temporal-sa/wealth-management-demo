# API

The HTTP API the shared web UI calls, at `http://127.0.0.1:8000`. It talks only to Temporal and Redis:
it starts and signals the chat workflow, reads the conversation from the Redis event stream, and sets
the chaos flags. The code is [`src/api/server.ts`](../src/api/server.ts) (Express); the start scripts
are in this folder.

It needs a running Temporal service, Redis, and a [worker](../src/temporal_supervisor/README.md#start-the-worker):
without a worker the chat gets no answers.

## Run

Against a local Temporal service:

```bash
api/startlocalapi.sh
```

Against Temporal Cloud, with `setcloudenv.sh` at the repository root (see
[Running on Temporal Cloud](../src/temporal_supervisor/README.md#running-on-temporal-cloud)):

```bash
api/startcloudapi.sh
```

Both scripts source `setclaimcheck.sh` from the repository root if it exists, so the API reads the
same claim-checked payloads as the worker. The API prints whether the claim check is on at startup.
`API_HOST` and `API_PORT` change where it listens.

## Endpoints

| Method and path | Parameters | Does |
| --- | --- | --- |
| `POST /start-workflow` | `workflow_id` | Starts `WealthManagementWorkflow` on `TEMPORAL_TASK_QUEUE` (default `Supervisor`), with ID reuse allowed |
| `POST /send-prompt` | `workflow_id`, `prompt` | Sends the `process_user_message` signal |
| `GET /get-chat-history` | `workflow_id`, `from_index` | Returns the events in `events:<workflow ID>` from that index. Each event is `{type, content}`, where `type` is `chat_interaction` or `status_update` |
| `POST /end-chat` | `workflow_id` | Sends the `end_workflow` signal |
| `GET /chaos` | none | The chaos flags with their label, description and on/off state, and the last 20 injected failures |
| `POST /chaos` | `flag`, `enabled` | Turns one flag on or off |
| `POST /chaos/reset` | none | Turns every flag off and clears the failure log |

Parameters are query parameters, as the web UI sends them. For example, with a worker running:

```bash
curl -X POST "http://127.0.0.1:8000/start-workflow?workflow_id=adk-ts-temporal-agent-test"
```

```bash
curl -X POST "http://127.0.0.1:8000/send-prompt?workflow_id=adk-ts-temporal-agent-test&prompt=Who%20are%20my%20beneficiaries%3F"
```

```bash
curl "http://127.0.0.1:8000/get-chat-history?workflow_id=adk-ts-temporal-agent-test&from_index=0"
```
