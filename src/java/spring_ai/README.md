# Wealth Management Agent Demo: Spring AI (Java)

A multi-agent banking chat that shows what Temporal adds to an AI agent. A customer lists, adds and deletes
beneficiaries, and lists, opens and closes investment accounts. Opening an account starts a child workflow with
KYC, a human compliance approval and a saga.

This version uses [Spring AI](https://docs.spring.io/spring-ai/reference/) in Java: each of the four agents is a
Spring AI chat client with its own tools, and the model is Gemini through Spring AI's Google GenAI integration. The
Temporal version runs on Temporal's official Spring AI integration,
[io.temporal:spring-ai](https://docs.temporal.io/develop/java/integrations/spring-ai) (Public Preview): every model
call is its chat model activity, and the tools run on the workflow thread. It implements the same demo as the other
frameworks and keeps their Temporal contracts, so the same web UI, scripts and compliance tooling work with it.

It shares the [API](../../python/api/README.md), the [web application](../../../frontend/README.md), the
[Java worker](../../../interop/open_account/java/README.md), `scripts/` and `data/` with the other frameworks. Java
has no shared `common/` folder like the other languages, so this framework has its own Java versions of the shared
pieces (the data store, the event stream, the chaos flags, sessions), with the same Redis keys and file formats.

Its chat workflows run on the `SpringAI-Supervisor` task queue by default, so its worker can run next to another
framework's. Start the API for it with `./startlocalapi.sh spring_ai`; the web app then names its chats
`springai-temporal-agent-session-<session>-chat-<random>`, and lists it in the sidebar under Java.

The demo is implemented twice:

* **[Standalone](docs/standalone.md)**: the same agents as a command-line chat, with a plain Spring AI chat client
  and no Temporal. Accounts are opened directly, without KYC, compliance review or a saga.
* **[Temporal](docs/temporal.md)**: the agents run inside a workflow, where every model call and every tool that
  touches a system is a durable activity. Includes the web UI, the account-opening child workflow and the chaos
  panel for failure demos.

## How the agents work

```
Supervisor Agent ──► Beneficiary Agent   (list_beneficiaries, add_beneficiary, delete_beneficiary)
       │  ▲
       ▼  │
Investment Agent    (list_investments, close_investment)
       │  ▲
       ▼  │
Open Account Agent  (open_new_investment_account, get_account_opening_status,
                     get_current_client_info, approve_kyc, update_client_details)
```

* **An agent** is a Spring AI `ChatClient` with its instructions and tools. Spring AI calls the model and runs the
  tools it asks for until the model answers.
* **A tool** is a plain `@Tool` method. In the Temporal version the integration runs it on the workflow thread, so a
  tool that touches a system runs an activity.
* **A handoff** is a `@Tool(returnDirect = true)` named `transfer_to_<agent_name>`. Spring AI has no multi-agent
  support, so a small turn loop ([agents/Conversation.java](src/main/java/io/temporal/demo/springai/agents/Conversation.java))
  does it: the handoff ends the agent's tool loop, and the agent handed off to answers the same customer message.
* **The pieces differ by version**: the standalone version's chat clients call Gemini and the data files directly;
  the Temporal version's are `TemporalChatClient`s whose model is the integration's `ActivityChatModel`, and whose
  tools run activities and start the account-opening child workflow.

## Scenarios

* List, add and delete beneficiaries (delete asks for confirmation first).
* List and close investment accounts (close asks for confirmation first).
* Open an investment account: deposit validation ($100 to $1,000,000), KYC confirmation or update of the customer's
  details, compliance approval from outside the chat, then a saga that creates, funds and registers the account,
  rolling back on failure.
* Failure demos from the UI's chaos panel: tool outage, model outage, model rate limiting, custodian rejection
  (saga rollback), slow saga steps, and a bug in workflow code that is fixed by editing one line while the workflow
  waits. See the [Temporal README](docs/temporal.md#failure-scenarios-chaos-panel).

## Prerequisites

| Tool | Version used | Needed for |
|------|--------------|------------|
| [Java JDK](https://adoptium.net/) | 25 | Everything |
| Gradle | 9.8 (the wrapper, `./gradlew`, downloads it) | Everything |
| [Temporal CLI](https://docs.temporal.io/cli) | 1.9 | Temporal version (local dev server, compliance approval script) |
| [Redis](https://redis.io/) | 8 | Temporal version (UI event stream, chaos flags) |
| [Node.js](https://nodejs.org/) | 26 (any LTS from 20 should work) | Web UI |
| [uv](https://docs.astral.sh/uv/) | 0.13 | The shared API (Python) |
| A Gemini API key | | Both versions |

It uses Spring Boot 4.1.1, Spring AI 2.0.3, Temporal's Java SDK 1.41.1 and `io.temporal:spring-ai` 0.1.1
([build.gradle](build.gradle)). The first build downloads the dependencies:

```bash
cd src/java/spring_ai
./gradlew build
```

## Gemini key setup

From the repository root, copy the example key file and fill in your Gemini key. `scripts/setgeminikey.sh` is
ignored by git, and the other Gemini frameworks use it too.

```bash
cp scripts/setgeminikey.example scripts/setgeminikey.sh
```

The scripts source it if it exists. `GEMINI_MODEL` picks the model (default `gemini-3.8-flash`, the same as the
other Gemini frameworks).

## Running the demo

Quick start for the Temporal version with the web UI. Each command runs in its own terminal, from the repository
root:

```bash
temporal server start-dev
```

```bash
redis-server
```

```bash
./src/java/spring_ai/scripts/startlocalworker.sh
```

```bash
./src/python/api/startlocalapi.sh spring_ai
```

```bash
cd frontend && npm install && npm start
```

Or start the worker, the API and the web UI in one terminal with `scripts/startdemo.sh spring_ai` (see the
[scripts README](../../../scripts/README.md)).

Open http://localhost:3000 and chat. To approve an account opening as the compliance officer, click **Approve
compliance review** in the status line, or:

```bash
./src/java/spring_ai/scripts/localsendcomplianceapproval.sh "<open-account workflow ID>"
```

The [Temporal README](docs/temporal.md) covers the details, and the [standalone README](docs/standalone.md) covers
the command-line chat.

## Demo data

The JSON files in [data/](../../../data) (beneficiaries, clients, funding accounts, investments) are the system of
record, and the demo changes them. They are tracked by git, so after a demo you can reset them with (from the
repository root):

```bash
git checkout data/
```

Tests and demo scripts rely on client 123 (Don Doe, 123 Main Street), with Checking, Savings and 401K accounts and
a $250,000 linked bank account.

## Tests

The tests need no Gemini key, no Redis and no running Temporal service. They use Temporal's test server, stub
activities and a scripted chat model, and run the real chat workflow through the real Spring AI plugin:

```bash
cd src/java/spring_ai
./gradlew test
```

See [Tests](docs/temporal.md#tests) in the Temporal README.

## Layout

| Path | Holds |
|------|-------|
| [build.gradle](build.gradle) | The Gradle build: Spring Boot, Spring AI, Temporal and the integration |
| [scripts/](scripts) | Start scripts: worker (local, cloud), compliance approval, standalone chat |
| [src/main/java/.../agents/](src/main/java/io/temporal/demo/springai/agents) | The agents, their prompts, handoffs and the turn loop, used by both versions |
| [src/main/java/.../workflows/](src/main/java/io/temporal/demo/springai/workflows) | The chat and open-account workflows, and the Temporal version's tools |
| [src/main/java/.../activities/](src/main/java/io/temporal/demo/springai/activities) | The activities, under the shared contract's names |
| [src/main/java/.../worker/](src/main/java/io/temporal/demo/springai/worker) | The worker, its connection, and the model call interceptor |
| [src/main/java/.../standalone/](src/main/java/io/temporal/demo/springai/standalone) | The standalone chat and its tools |
| [src/main/java/.../common/](src/main/java/io/temporal/demo/springai/common) | Java versions of the shared pieces: data store, event stream, chaos flags, sessions, task queues |
| [src/main/java/.../claimcheck/](src/main/java/io/temporal/demo/springai/claimcheck) | The claim check codec, as in the Java worker |
| [src/test/](src/test) | Tests, and a copy of the committed data files they seed from |
| [docs/](docs) | The Temporal and standalone READMEs |
