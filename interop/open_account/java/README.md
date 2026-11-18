# Java Open Investment Account Worker

An optional Java (Spring Boot) implementation of `OpenInvestmentAccountWorkflow`, the child workflow
the Open Account Agent starts to open a new investment account. It is a drop-in replacement for the
Python version in [`src/python/openai_agents/durable/workflows/open_account_workflow.py`](../../../src/python/openai_agents/durable/workflows/open_account_workflow.py):
same KYC and compliance steps, same saga (create the account record, debit the linked bank account,
register with the custodian, with compensations in reverse order), and the same status updates
signalled to the parent chat workflow.

The workflow has no business logic of its own. It calls the Python activities by name (`get_client`,
`open_investment`, `remove_investment`, `debit_linked_account`, `credit_linked_account`,
`register_account`) on the Python worker's task queue (`TEMPORAL_TASK_QUEUE`, default `Supervisor`),
so the Python worker must be running too, and the chaos panel's flags apply unchanged. The only Java
activity is the one that signals status changes to the parent workflow; it runs on the Open Account
task queue with the workflow.

As in the Python version, the `update_client_details` update saves the customer's changes (through the
Python `update_client` activity) and completes KYC.

## Prerequisites

* [Java JDK 25](https://adoptium.net/) - the Gradle wrapper (`./gradlew`, Gradle 9.8.2) is included, so no separate Gradle install is needed
* Everything the Python demo needs (Temporal CLI, Redis, uv, OpenAI API key). See the [Temporal README](../../../src/python/openai_agents/durable/README.md).

## Running Locally

Start Temporal (`temporal server start-dev`) and Redis (`redis-server`).

The Open Account task queue name is passed as the first argument to both workers. Start the Python
worker with it, so the supervisor starts the child workflow on that queue (and doesn't register the
Python version of the workflow):

```bash
cd src/python/openai_agents/durable
./startlocalworker.sh Open-Account-Java
```

Then, from the repository root, start the Java worker with the same name:

```bash
cd interop/open_account/java
./startlocalworker.sh Open-Account-Java
```

The Java workflow calls the port's activities (Python or TypeScript) on its main task queue, `TEMPORAL_TASK_QUEUE`
(default `Supervisor`, the OpenAI Agents port's). For another port, set it to that port's queue:

| Port | Start the Java worker with |
|---|---|
| OpenAI Agents SDK | `./startlocalworker.sh Open-Account-Java` |
| Pydantic AI | `TEMPORAL_TASK_QUEUE=PY-AI-Supervisor ./startlocalworker.sh Open-Account-Java` |
| Strands Agents | `TEMPORAL_TASK_QUEUE=wealth-management-strands ./startlocalworker.sh Open-Account-Java` |
| Google ADK (Python) | `TEMPORAL_TASK_QUEUE=ADK-Supervisor ./startlocalworker.sh Open-Account-Java` |
| Pure Python (LiteLLM) | `TEMPORAL_TASK_QUEUE=Pure-Supervisor ./startlocalworker.sh Open-Account-Java` |
| Vercel AI SDK (TypeScript) | `TEMPORAL_TASK_QUEUE=VAI-Supervisor ./startlocalworker.sh Open-Account-Java` |

The script sets `TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT` from the argument, sources `scripts/setclaimcheck.sh`
if it exists (claim check is optional) and runs `./gradlew runWorker`. It connects to `127.0.0.1:7233`, namespace `default`, as set
in `src/main/resources/application.yaml`. The worker doesn't read `TEMPORAL_ADDRESS`, but the activity
that reports each state change to the chat workflow does (default `localhost:7233`), so to use another
local server set both, e.g. `SPRING_TEMPORAL_CONNECTION_TARGET=127.0.0.1:17233 TEMPORAL_ADDRESS=127.0.0.1:17233`. When claim check is enabled, the Java worker uses the Redis at
`spring.data.redis` in `application.yaml` (`localhost:6379`), not `REDIS_HOST` / `REDIS_PORT`.

Start the API and the UX as described in the [Temporal README](../../../src/python/openai_agents/durable/README.md),
and send the compliance approval with `src/python/openai_agents/durable/localsendcomplianceapproval.sh` as usual.

To try the Java workflow without the chat or an OpenAI key, run the open-account scenarios against it
(with this worker running): `src/python/openai_agents/durable/startlocalopenaccount.sh Open-Account-Java`. See
"Testing the Open Account workflow on its own" in the [Temporal README](../../../src/python/openai_agents/durable/README.md).

## Running with Temporal Cloud

Create `scripts/setcloudenv.sh` (copy `scripts/setcloudenv.example`)
as described in the [Temporal README](../../../src/python/openai_agents/durable/README.md#running-the-demo-in-temporal-cloud).
Start the Python worker with the queue name, then the Java worker with the same name:

```bash
cd src/python/openai_agents/durable
./startcloudworker.sh Open-Account-Java
```

```bash
cd interop/open_account/java
./startcloudworker.sh Open-Account-Java
```

The Java cloud script can be run from any directory. It sources `scripts/setclaimcheck.sh` (if it exists) and `scripts/setcloudenv.sh`, maps `TEMPORAL_TLS_CLIENT_CERT_PATH` to the
`TEMPORAL_CERT_PATH` the Java worker reads, uses the Spring profile `tc`
(`src/main/resources/application-tc.yaml`), and runs `./gradlew runWorker`. With this profile, the
claim check Redis comes from `REDIS_HOST` / `REDIS_PORT` (default `localhost:6379`).

Java's TLS needs the client key as an unencrypted PKCS8 key (`-----BEGIN PRIVATE KEY-----`). If
`TEMPORAL_TLS_CLIENT_KEY_PATH` points to a different format, the script stops and prints the command
to convert it, for example:

```bash
openssl pkcs8 -topk8 -nocrypt -in /path/to/key.key -out /path/to/key.pkcs8.key
```

Then add the converted key to `scripts/setcloudenv.sh` (the Python components keep using
`TEMPORAL_TLS_CLIENT_KEY_PATH`):

```bash
export TEMPORAL_KEY_PKCS8_PATH="/path/to/key.pkcs8.key"
```

## Bug in the workflow code (chaos panel)

The chaos panel's **Bug in workflow code** switch gives new account openings the promo code
`WELCOME-BONUS`. In `src/main/java/io/temporal/demo/wealthmanagement/workflow/OpenInvestmentAccountWorkflowImpl.java`,
`BONUS_RATES` is keyed by `"WELCOME_BONUS"` (underscore), so `welcomeBonus` throws a
`NullPointerException` right after compliance approval. The exception fails the workflow task, not the
workflow, so the workflow stays **Running**, paused at that line. To fix it, use the commented-out
`BONUS_RATES` line above it and restart the Java worker; the workflow resumes on the next
workflow-task retry. Re-arm the bug afterwards, from the repository root:

```bash
git checkout interop/open_account/java/src/main/java/io/temporal/demo/wealthmanagement/workflow/OpenInvestmentAccountWorkflowImpl.java
```

See [Failure scenarios](../../../src/python/openai_agents/durable/README.md#failure-scenarios-chaos-panel) for the other scenarios.

## Tests

The saga, retry and workflow-bug tests use the Temporal Java SDK's in-memory test environment with
stub activities, so no Temporal server, Redis or OpenAI key is needed:

```bash
cd interop/open_account/java
./gradlew test
```
