# Java Open Investment Account Worker

An optional Java (Spring Boot) implementation of `OpenInvestmentAccountWorkflow`, the child workflow
the Open Account Agent starts to open a new investment account. It is a drop-in replacement for the
Python version in [`src/python/openai_agents/durable/workflows/open_account_workflow.py`](../../../src/python/openai_agents/durable/workflows/open_account_workflow.py):
same KYC and compliance steps, same saga (create the account record, debit the linked bank account,
register with the custodian, with compensations in reverse order), and the same status updates
signalled to the parent chat workflow.

The workflow has no business logic of its own. It calls the Python activities by name (`get_client`,
`open_investment`, `remove_investment`, `debit_linked_account`, `credit_linked_account`,
`register_account`) on the framework's task queue (`TEMPORAL_TASK_QUEUE`, which has no default), so the
framework's worker must be running too, and the chaos panel's flags apply unchanged. The only Java
activity is the one that signals status changes to the parent workflow; it runs on the Open Account
task queue with the workflow.

As in the Python version, the `update_client_details` update saves the customer's changes (through the
Python `update_client` activity) and completes KYC.

## Prerequisites

* [Java JDK 25](https://adoptium.net/) - the Gradle wrapper (`./gradlew`, Gradle 9.8.2) is included, so no separate Gradle install is needed
* Everything the Python demo needs (Temporal CLI, Redis, uv, OpenAI API key). See the [Temporal README](../../../src/python/openai_agents/durable/README.md).

## Running Locally

Start Temporal (`temporal server start-dev`) and Redis (`redis-server`).

Each framework has its own task queue, and the Java worker serves one framework at a time: set
`TEMPORAL_TASK_QUEUE` to that framework's queue. The worker then runs the open-account workflow on that
framework's own `<TEMPORAL_TASK_QUEUE>-open-account` queue, and calls the framework's activities on
`TEMPORAL_TASK_QUEUE`. Since every framework has its own open-account queue, several frameworks can each have a
Java worker at once. There is no default: without `TEMPORAL_TASK_QUEUE`, the worker stops and says so.

Start the framework's worker with the argument `java`, so its chat workflow starts the child workflow on
that queue (and doesn't register its own version of the workflow). For the OpenAI Agents framework:

```bash
src/python/openai_agents/durable/startlocalworker.sh java
```

Then start the Java worker for the same framework:

```bash
cd interop/open_account/java
TEMPORAL_TASK_QUEUE=OAI-Supervisor ./startlocalworker.sh
```

For another framework, start its worker with `java` and the Java worker with that framework's queue:

| Framework | Start the Java worker with | Open-account queue |
|---|---|---|
| OpenAI Agents SDK | `TEMPORAL_TASK_QUEUE=OAI-Supervisor ./startlocalworker.sh` | `OAI-Supervisor-open-account` |
| Pydantic AI | `TEMPORAL_TASK_QUEUE=PYAI-Supervisor ./startlocalworker.sh` | `PYAI-Supervisor-open-account` |
| Strands Agents | `TEMPORAL_TASK_QUEUE=Strands-Supervisor ./startlocalworker.sh` | `Strands-Supervisor-open-account` |
| Google ADK (Python) | `TEMPORAL_TASK_QUEUE=ADK-Supervisor ./startlocalworker.sh` | `ADK-Supervisor-open-account` |
| Pure Python (LiteLLM) | `TEMPORAL_TASK_QUEUE=Pure-Supervisor ./startlocalworker.sh` | `Pure-Supervisor-open-account` |
| Vercel AI SDK (TypeScript) | `TEMPORAL_TASK_QUEUE=VAI-Supervisor ./startlocalworker.sh` | `VAI-Supervisor-open-account` |
| Google ADK (TypeScript) | `TEMPORAL_TASK_QUEUE=ADK-TS-Supervisor ./startlocalworker.sh` | `ADK-TS-Supervisor-open-account` |
| Google ADK (Go) | `TEMPORAL_TASK_QUEUE=ADK-Go-Supervisor ./startlocalworker.sh` | `ADK-Go-Supervisor-open-account` |

An argument to the Java script names another open-account queue (`TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT`);
pass the same name to the framework's worker script instead of `java`.

The script checks `TEMPORAL_TASK_QUEUE`, sources `scripts/setclaimcheck.sh`
if it exists (claim check is optional) and runs `./gradlew runWorker`. It connects to `127.0.0.1:7233`, namespace `default`, as set
in `src/main/resources/application.yaml`. The worker doesn't read `TEMPORAL_ADDRESS`, but the activity
that reports each state change to the chat workflow does (default `localhost:7233`), so to use another
local server set both, e.g. `SPRING_TEMPORAL_CONNECTION_TARGET=127.0.0.1:17233 TEMPORAL_ADDRESS=127.0.0.1:17233`. When claim check is enabled, the Java worker uses the Redis
at `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` (default `localhost:6379`, no password), or at `REDIS_URL` when it is set
(the script passes it to Spring as `SPRING_DATA_REDIS_URL`).

Start the API and the UX as described in the [Temporal README](../../../src/python/openai_agents/durable/README.md),
and send the compliance approval with `src/python/openai_agents/durable/localsendcomplianceapproval.sh` as usual.

To try the Java workflow without the chat or an OpenAI key, run the open-account scenarios against it
(with this worker running for `OAI-Supervisor`): `src/python/openai_agents/durable/startlocalopenaccount.sh java`. See
"Testing the Open Account workflow on its own" in the [Temporal README](../../../src/python/openai_agents/durable/README.md).

## Running with Temporal Cloud

Create `scripts/setcloudenv.sh` (copy `scripts/setcloudenv.example`)
as described in the [Temporal README](../../../src/python/openai_agents/durable/README.md#running-on-temporal-cloud).
Start the framework's worker with `java`, then the Java worker with the framework's queue:

```bash
src/python/openai_agents/durable/startcloudworker.sh java
```

```bash
cd interop/open_account/java
TEMPORAL_TASK_QUEUE=OAI-Supervisor ./startcloudworker.sh
```

The Java cloud script can be run from any directory. It sources `scripts/setclaimcheck.sh` (if it exists) and `scripts/setcloudenv.sh`, maps `TEMPORAL_TLS_CLIENT_CERT_PATH` to the
`TEMPORAL_CERT_PATH` the Java worker reads, uses the Spring profile `tc`
(`src/main/resources/application-tc.yaml`), and runs `./gradlew runWorker`. With this profile, the
claim check Redis comes from `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` (default `localhost:6379`, no password), or
`REDIS_URL` when it is set.

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
stub activities, so no Temporal server, Redis or OpenAI key is needed (the test task sets
`TEMPORAL_TASK_QUEUE`):

```bash
cd interop/open_account/java
./gradlew test
```
