# Temporal version: Google ADK for Go on Temporal

The chat runs as one long-lived Temporal workflow, `WealthManagementWorkflow`. Its agents run inside
the workflow with Temporal's [Go integration for Google ADK](https://docs.temporal.io/develop/go/integrations/google-adk)
(`go.temporal.io/googleadk`), so every model call and every tool that does I/O is a durable activity.
Each account opening is a child workflow, `OpenInvestmentAccountWorkflow`.

![Web UI](../images/webui.png)

## Architecture

```text
 React web UI ──► API (cmd/api, :8000) ──► Temporal ◄── Worker (cmd/worker)
      ▲                │                                  │  task queue Supervisor:
      │                └──► Redis ◄───────────────────────┤    WealthManagementWorkflow (chat)
      └── polls the chat's events (events:<chat ID>)      │    OpenInvestmentAccountWorkflow
          and the chaos flags (chaos:flags)               │    tool activities
                                                          │  task queue Supervisor-llm:
                                                          │    googleadk.InvokeModel ──► Gemini
```

* The **API** starts the chat workflow, signals each customer message to it, and reads the
  conversation from the chat's Redis event stream. The UI polls the API.
* The **chat workflow** runs the ADK agent tree for each message, one message at a time:

  ```text
  Supervisor_Agent
  ├── Beneficiary_Agent       tools: list_beneficiaries, add_beneficiary, delete_beneficiary
  └── Investment_Agent        tools: list_investments, close_investment
      └── Open_Account_Agent  tools: open_new_investment_account, get_account_opening_status,
                                     get_current_client_info, approve_kyc, update_client_details
  ```

  Agents hand off with ADK's built-in `transfer_to_agent`, in the same turn as the request. A
  specialist hands back to its parent, never sideways. Each agent's model is a
  `googleadk.NewModel`, so its calls run as the integration's `googleadk.InvokeModel` activity on
  their own task queue. The tools run in the workflow and call the activities listed under
  [Temporal contracts](#temporal-contracts). After each turn the workflow appends a
  `chat_interaction` event to Redis.
* The customer gives their client ID once. A before-tool callback saves it from the first tool call
  that uses it, and every agent's instructions include it from then on.
* The **open-account workflow** reads the client's details, waits for KYC and then for compliance
  approval, and runs the saga. It signals every state change to the chat, which records it and
  appends a `status_update` event.

## Running the demo locally

Do the setup in the [root README](../README.md) first (prerequisites and Gemini key). Each command
below runs in its own terminal, from the repository root.

### Start Temporal and Redis

```bash
temporal server start-dev
```

```bash
redis-server
```

The Temporal UI is at http://localhost:8233.

### Start the worker

```bash
./scripts/startlocalworker.sh
```

### Start the API

```bash
./scripts/startlocalapi.sh
```

The API listens on http://127.0.0.1:8000.

### Start the web UI

```bash
cd frontend && npm install && npm start
```

The UI opens at http://localhost:3000. Click **Start Chat**, then for example:

1. *Who are my beneficiaries?* The supervisor hands off to the Beneficiary Agent, which asks for your client ID.
2. *123* It lists John, Jane and Joan Doe.
3. *What investments do I have?* The Beneficiary Agent hands back to the supervisor, which hands off to the Investment Agent, which lists Checking, Savings and 401K, all in this one turn.
4. *Open Vacation with $13,000* The Open Account Agent starts an opening and shows your details for KYC.
5. *Yes* KYC is approved and the opening waits for compliance review.

### Send the compliance approval

Compliance approval comes from outside the chat, from a compliance officer. Find the opening's
workflow ID in the chat's JSON output or the Temporal UI, or list the openings:

```bash
temporal workflow list --query "WorkflowType='OpenInvestmentAccountWorkflow' AND ExecutionStatus='Running'"
```

Then send the approval, quoting the ID:

```bash
./scripts/localsendcomplianceapproval.sh "OpenAccount-<chat workflow ID>-123-Vacation-1"
```

Ask the agent for the status: it reads it with `get_account_opening_status`, and reports
`Complete`.

## Claim check (optional)

The claim check substitutes every payload sent to Temporal (workflow and activity inputs and results,
signals, queries and updates) with an ID. This is the
[Claim Check pattern](https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html).
A [payload codec](https://docs.temporal.io/develop/go/converters-and-encryption#custom-payload-codec)
([internal/claimcheck](../internal/claimcheck/claimcheck.go)) stores the original payload in Redis under
a new UUID, and puts only the UUID in the event history. Its format matches the other ports' Python and
Java codecs, so the Java worker works with it too.

To turn it on, from the repository root:

```bash
cp setclaimcheck.example setclaimcheck.sh
```

`setclaimcheck.sh` sets `USE_CLAIM_CHECK=true` and where Redis is. It is git-ignored. Every start
script sources it if it exists, so the worker, the API, the compliance and open-account scripts, the
codec server and the Java worker all use the codec. They must: a component without it can't read the
others' payloads. Restart anything already running after you create or delete the file. Every program prints a
`Claim check: ON` or `Claim check: OFF` line when it starts, so you can check they agree.

The demo uses one Redis for the chat events, the chaos flags and the claim check. A claim check adds a
Redis call for every payload, and Redis being down then stops the workflows, so use a reliable Redis in
production. The stored payloads have no expiry: clear them with `redis-cli flushdb` when the demo is
done (this also clears the chat events and chaos flags).

### Codec server

With the claim check on, the Temporal UI only shows each payload's UUID. The codec server lets it show
the real data. Start it:

```bash
./scripts/startcodecserver.sh
```

It listens on http://127.0.0.1:8081 (`CODEC_SERVER_ADDRESS` changes it). Open the Temporal UI at exactly
http://localhost:8233 (not 127.0.0.1), or https://cloud.temporal.io for Temporal Cloud: the codec server
only accepts requests from those origins. Click the glasses icon at the top right, choose **Use my browser
setting and ignore Cluster-level setting**, enter `http://127.0.0.1:8081` with no trailing spaces, turn
off **Pass the user access token** and **Include cross-origin credentials**, and click **Apply**.

![Codec server settings](../images/config-codec-server.png)

The UI now shows the decoded payloads:

![Decoded input](../images/decoded-input.png)

Without the codec server, it shows only the Base64-encoded ID:

![Encoded input](../images/encoded-input.png)

## Running the demo on Temporal Cloud

The worker, the API and the compliance script read the Temporal connection from the environment.
Copy the example file and fill in your namespace and its mTLS client certificate and key:

```bash
cp setcloudenv.example setcloudenv.sh
```

`setcloudenv.sh` sets `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_CLIENT_CERT_PATH` and
`TEMPORAL_TLS_CLIENT_KEY_PATH`. It is git-ignored: never commit it. (The Go SDK also reads
`TEMPORAL_API_KEY`, if your namespace uses an API key instead of mTLS.)

Start Redis, then each of these in its own terminal, from the repository root:

```bash
./scripts/startcloudworker.sh
```

```bash
./scripts/startcloudapi.sh
```

```bash
cd frontend && npm install && npm start
```

Send compliance approval with the Cloud script, quoting the workflow ID:

```bash
./scripts/cloudsendcomplianceapproval.sh "OpenAccount-<chat workflow ID>-123-Vacation-1"
```

Watch the workflows in the Temporal Cloud UI, in your namespace. `startcloudworker.sh <queue>` moves the
open-account workflow onto another task queue, as `startlocalworker.sh <queue>` does.

## How account opening works

* `open_new_investment_account` first runs `validate_new_account`. A deposit under $100 or over
  $1,000,000 fails it on the first attempt (a non-retryable `DepositBelowMinimum` or
  `DepositLimitExceeded`), and the agent explains the refusal. No workflow starts.
* Every request to open an account starts a **new** opening, with its own KYC, even if an account with
  the same name was opened, or is still being opened, earlier in the chat. The child workflow ID is

  ```text
  OpenAccount-<chat workflow ID>-<client ID>-<account name>-<n>
  ```

  where `<n>` counts the openings started in this chat, so two "Vacation" openings are
  `...-Vacation-1` and `...-Vacation-2`. A refused request doesn't use up a number.
* The child is started with parent close policy `TERMINATE` on `TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT`.
  Its state is `Initializing` from the start.
* The agent shows the customer's details (`get_current_client_info`, which runs the child's
  `get_client_details` update) and asks if they are correct. `approve_kyc` refuses unless this
  opening's details were shown in a reply and the customer has answered since. If the customer
  changes a detail instead, `update_client_details` saves it and completes KYC.
* After compliance approval, the saga runs, reporting each state:

  ```text
  Compliance review has been approved. Creating Investment Account
  Creating the account record.                     (open_investment)
  Transferring $13,000.00 from the linked bank account.   (debit_linked_account)
  Registering the account with the custodian.     (register_account)
  Complete
  ```

  If a step fails with a non-retryable error, it reports `Failed: <reason>. Rolling back.`, runs the
  completed steps' compensations in reverse order (`Rolling back: <description>.` before each), and
  ends with `Rolled back. The account was not opened: <reason>.` Compensations retry until they
  succeed. Transfers use the IDs `<workflow ID>-<run ID>-initial-deposit` and `...-refund`, so a
  retried transfer never moves money twice.

### With the Java open-account workflow

The optional [Java worker](../java/README.md) runs `OpenInvestmentAccountWorkflow` on its own task
queue and calls this port's activities by name. Start the Go worker with the queue name, then the Java
worker with the same name:

```bash
./scripts/startlocalworker.sh Open-Account-Java
```

```bash
cd java && ./startlocalworker.sh Open-Account-Java
```

The Java version has its own bug in workflow code: see the [Java README](../java/README.md).

### Testing the open-account workflow on its own

The open-account runner runs `OpenInvestmentAccountWorkflow` directly, with no chat and no model key,
for three scenarios: KYC approved, client details updated, and compliance approval sent by hand. It
starts its own worker and stops it on exit:

```bash
./scripts/startlocalopenaccount.sh
```

To run them on the Java worker instead, start it first (above), then pass its queue name:
`./scripts/startlocalopenaccount.sh Open-Account-Java`.

When the third scenario waits for compliance approval, send it from another terminal:

```bash
./scripts/localsendcomplianceapproval.sh testing-open-investment-account-workflow3
```

Scenario 2 changes Don Doe's last name to Doenut, so reset the data afterwards with `git checkout data/`.

## Environment variables

| Variable | Default | Used by | What it does |
|---|---|---|---|
| `GEMINI_API_KEY` | none | worker, CLI | Gemini API key (or `GOOGLE_API_KEY`). Set in `setgeminikey.sh`. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | worker, CLI | The Gemini model every agent uses |
| `TEMPORAL_ADDRESS` | `127.0.0.1:7233` | all | Temporal service address |
| `TEMPORAL_NAMESPACE` | `default` | all | Temporal namespace |
| `TEMPORAL_TLS_CLIENT_CERT_PATH`, `TEMPORAL_TLS_CLIENT_KEY_PATH` | none | all | mTLS client certificate and key, for Temporal Cloud. Set in `setcloudenv.sh`. |
| `TEMPORAL_TASK_QUEUE` | `Supervisor` | worker, API | Task queue of the chat workflow and the tool activities |
| `TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT` | the chat's queue | worker, runner | Task queue of the open-account workflow. `startlocalworker.sh <queue>` sets it; the worker then doesn't run that workflow. |
| `TEMPORAL_TASK_QUEUE_LLM` | `<TEMPORAL_TASK_QUEUE>-llm` | worker | Task queue of the model calls |
| `LLM_MAX_CALLS_PER_SECOND` | unlimited | worker | Rate limit the Temporal service applies to model calls, across all workers |
| `REDIS_URL` | none | worker, API | `redis://:<password>@<host>:<port>/<db>`; wins over the three below |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | `localhost`, `6379`, none | worker, API | Where Redis is |
| `USE_CLAIM_CHECK` | off | all | `true`, `yes` or `1` turns on the claim-check codec. Set in `setclaimcheck.sh`. |
| `CODEC_SERVER_ADDRESS` | `127.0.0.1:8081` | codec server | Where the codec server listens |
| `DATA_DIR` | `data/` above the working directory | worker, CLI | Folder of the demo data files |
| `API_ADDRESS` | `127.0.0.1:8000` | API | Where the API listens |
| `LIVE_TEST_RUNS` | `1` | live tests | How many times each live test repeats its conversation |

## Failure scenarios

Open the chaos panel with the **Chaos** button in the web UI. Each switch takes effect at once, with no
restart: activities and every model call read the flags from the Redis hash `chaos:flags` on each
attempt. If Redis can't be reached, the flags read as off. Each injected failure is logged to the
Redis list `chaos:events` for the panel. Watch the retries in the Temporal UI.

| Flag | Panel label | What happens |
|---|---|---|
| `tool_down` | Core banking API down | Investment and beneficiary activities return a connection error and retry until you turn it off. The agent's reply waits mid-turn; nothing is lost or asked again. |
| `llm_down` | Gemini API down | Every model call returns a connection error. The `googleadk.InvokeModel` activity retries, and the turn resumes where it stopped. |
| `llm_rate_limited` | Gemini rate limited (429) | Every model call fails with a 429. Its next retry waits 15 s, like a Retry-After header, overriding the backoff. The Gen AI SDK's own HTTP retries are off, so Temporal decides when to retry. |
| `custodian_rejects` | Custodian rejects new accounts | `register_account` fails with a non-retryable `CustodianRejected`. The saga refunds the deposit, then removes the account record. |
| `slow_saga` | Slow account-opening steps | Each saga step sleeps 4 s, so you can watch the saga, or stop the worker partway and restart it. |
| `workflow_bug` | Bug in workflow code | `find_promotion` returns the promo code `WELCOME-BONUS`, whose code path has a bug (below). |

Three more scenarios need no flag:

* **Business rule:** ask to open an account with more than $1,000,000 or less than $100.
* **Insufficient funds:** open an account with $300,000. The linked bank account holds $250,000, so
  the debit fails with a non-retryable `InsufficientFunds` and the saga rolls back.
* **Proactive rate limiting:** model calls run on their own task queue, and
  `LLM_MAX_CALLS_PER_SECOND` sets a dispatch rate on it, so the Temporal service queues model calls
  instead of letting them hit the provider's limit.

Model calls run under the `googleadk.InvokeModel` activity, which wraps any error the model returns in
its own `ApplicationError`. A retry delay set inside the model would be lost, so the model worker has
an activity interceptor ([internal/llm](../internal/llm/llm.go)) that sets the 15 s next retry delay on
a rate-limited call's final error.

### Bug in workflow code

With `workflow_bug` on, new openings get the `WELCOME-BONUS` promo code, and the welcome-bonus code in
[internal/workflows/openaccount.go](../internal/workflows/openaccount.go) has a deliberate bug, marked
`*** Bug-In-Workflow-Code ***`:

```go
// promo := promotions[*in.PromoCode]
promo := promotions["WELCOME_BONUS"]
```

It looks the promotion up under `WELCOME_BONUS`, but the promo code is `WELCOME-BONUS`, so it gets a nil
pointer and panics. A panic fails the **workflow task**, not the workflow: the opening stays
**Running**, right after compliance approval, with the approval kept, and Temporal retries the task.
The Temporal UI shows the failed workflow task and its stack trace.

Turning the flag off doesn't unstick an opening that already has the promo code. To fix it, uncomment
the first line, comment out the second, and restart the worker. On the next workflow task retry the
opening carries on and opens the account with the bonus. To demo it again, put the bug back.

## Tests

The default suite needs no API key, no Redis and no running Temporal service. It uses the Temporal Go
SDK's test environment, stub activities and a scripted model. The bug test starts a Temporal dev
server itself, using the `temporal` CLI on your PATH (or downloading it).

```bash
go test ./...
```

It covers:

| Test | Checks |
|---|---|
| `TestSagaSuccess`, `TestSagaRollbackCustodianRejects`, `TestSagaRollbackInsufficientFunds`, `TestSagaStateSequence` | The saga, both rollbacks and the reported states |
| `TestToolOutageRetries`, `TestModelOutageRetries`, `TestRateLimitRetryDelay` | Retries during a tool and a model outage, and the 15 s delay after a 429 |
| `TestBusinessRuleRefusal` | Deposits over $1,000,000 or under $100 are refused before any workflow starts |
| `TestWorkflowBugPausesWorkflow` | The bug fails the workflow task while the workflow stays Running |
| `TestKYCGuardAndRepeatOpening` | `approve_kyc` refuses until this opening's details were shown in an earlier turn; two "Vacation" openings start `-Vacation-1` and `-Vacation-2`, each with its own KYC |
| `TestClientIDSharedAcrossAgents` | Every agent is told the client ID once a tool has used it; handoffs happen in one turn |
| `TestOffTopicPrompt` (both versions), `TestPRDPromptLines` | The Supervisor Agent's prompt declines off-topic questions; the PRD's required prompt lines |
| `TestFormat`, `TestDecodeOtherPorts`, `TestDataConverterRoundTrip` | The claim-check payload format, decoding the Python and Java codecs' payloads, and a round trip (with an in-memory Redis) |

The web UI's smoke test:

```bash
cd frontend && npm install && CI=true npm test
```

The Java worker's own tests (JDK 25):

```bash
cd java && ./gradlew clean build && ./gradlew test
```

The live tests call the real Gemini API, so they are kept out of the default run. They run the real
chat workflow on a dev server they start, with an in-memory event stream and the chaos flags off, and
print each run's transcript:

```bash
source setgeminikey.sh && LIVE_TEST_RUNS=3 go test -tags live ./tests/ -v
```

* `TestLiveAgentHandoffs`: "Who are my beneficiaries?", "123", "What investments do I have?". The
  beneficiaries are listed; in the last turn the Beneficiary Agent hands back to the supervisor, which
  hands off to the Investment Agent, which lists Checking, Savings and 401K without asking for the
  client ID again; no reply mentions a transfer.
* `TestLiveRepeatOpening`: the same three messages, then "Open Vacation with $13,000", "Yes" and
  "Open Vacation with $13,000". Both open replies show the KYC details, and openings `-Vacation-1` and
  `-Vacation-2` were started.

## Temporal contracts

These names and payloads match the other ports exactly, so their scripts and workers work with this one.

| Workflow | Kind | Name | Payload |
|---|---|---|---|
| `WealthManagementWorkflow` | Signal | `process_user_message` | `{user_input}` |
| | Signal | `end_workflow` | none |
| | Signal | `update_account_opening_state` | `{account_name, state, workflow_id}` |
| | Query | `get_chat_history` | list of `{user_prompt, text_response, json_response, agent_trace}` |
| `OpenInvestmentAccountWorkflow` | Input / output | | `{client_id, account_name, initial_amount, promo_code}` / `{account_created, message}` |
| | Query | `get_current_state` | the state string |
| | Update | `get_client_details` | returns `{first_name, last_name, address, phone, email, marital_status}` |
| | Update | `update_client_details` | the changed fields; saves them and completes KYC |
| | Signal | `verify_kyc`, `compliance_approved` | none |

Activities: `list_beneficiaries`, `add_beneficiary`, `delete_beneficiary`, `list_investments`,
`close_investment`, `validate_new_account`, `find_promotion`, `open_investment`, `remove_investment`,
`get_client`, `update_client`, `debit_linked_account`, `credit_linked_account`, `register_account`,
`get_current_client_info`, `approve_kyc`, `update_client_details`, `append_chat_interaction`,
`append_status_update` and `delete_conversation`. Tool activities retry from 1 s, doubling, up to
5 s apart; model calls up to 10 s apart. Neither has an attempt limit, and both use start-to-close
timeouts, so an outage is waited out instead of timing out.

## API

| Method and path | Parameters | Does |
|---|---|---|
| `POST /start-workflow` | `workflow_id` | Starts the chat workflow |
| `POST /send-prompt` | `workflow_id`, `prompt` | Sends `process_user_message` |
| `GET /get-chat-history` | `workflow_id`, `from_index` | Returns the chat's events from `events:<workflow ID>`, from that index |
| `POST /end-chat` | `workflow_id` | Sends `end_workflow` |
| `GET /chaos` | none | The flags, with label, description and state, and the last 20 injected failures |
| `POST /chaos` | `flag`, `enabled` | Turns one flag on or off |
| `POST /chaos/reset` | none | Turns every flag off and clears the failure log |
