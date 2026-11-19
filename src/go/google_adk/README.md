# Wealth Management Agent Demo: Google ADK for Go

A multi-agent banking chat that shows what Temporal adds to an agent framework, built with the
[Google Agent Development Kit for Go](https://google.github.io/adk-docs/) and Temporal's
[Go integration for Google ADK](https://docs.temporal.io/develop/go/integrations/google-adk)
(`go.temporal.io/googleadk`).

A customer can:

* list, add and delete **beneficiaries**;
* list, open and close **investment accounts**.

Opening an account starts a child workflow with KYC (the customer confirms their details), a
human compliance approval and a saga that creates, funds and registers the account, rolling back if
a step fails.

This port was imported from [temporal-sa/adk-go-wealth-management](https://github.com/temporal-sa/adk-go-wealth-management).
It is the first Go port: its framework-free packages are in [`src/go/internal/common`](../internal/common) for
the Go ports to share, and it shares the [API](../../python/api/README.md) (written in Python), the
[web application](../../../frontend/README.md), the [Java worker](../../../interop/open_account/java/README.md),
`scripts/` and `data/` with every port. Its chat workflows keep the same Temporal contract as the other ports,
which is what lets the Python API serve it. The Go module is [`src/go/go.mod`](../go.mod).

Its chat workflows run on the `ADK-Go-Supervisor` task queue by default (`DefaultTaskQueue` in
[internal/config](internal/config/config.go)), so its worker can run next to another port's. Start the API for
it with the `google_adk_go` AI framework (`./startlocalapi.sh google_adk_go`); the web app then names its chats
`adk-go-temporal-agent-<random>`.

The demo comes in two versions:

| Version | What it is | README |
|---|---|---|
| Temporal | Every model call and tool call is a durable Temporal activity. A web UI, a chaos panel that injects failures, and the account-opening workflow. | [docs/temporal.md](docs/temporal.md) |
| Standalone | The same agents with Google ADK alone, as a command-line chat. No KYC, compliance review or saga. | [docs/standalone.md](docs/standalone.md) |

## Prerequisites

* [Go](https://go.dev/dl/) 1.26.10 or later
* The [Temporal CLI](https://docs.temporal.io/cli#install), for a local Temporal service (tested with 1.9)
* [Redis](https://redis.io/docs/latest/operate/oss_and_stack/install/) 7 or later, on localhost:6379
* [Node.js](https://nodejs.org/en/download) 18 or later, with npm, for the web UI
* A [Gemini API key](https://aistudio.google.com/apikey)
* Optional, for the Java open-account worker: [JDK 25](https://adoptium.net/)

## Set up your Gemini API key

From the repository root, copy the shared Gemini key file (the other Gemini ports use it too) and put your key
in it. `scripts/setgeminikey.sh` is git-ignored: never commit a real key.

```bash
cp scripts/setgeminikey.example scripts/setgeminikey.sh
```

The default model is **Gemini `gemini-3.8-flash`**. To use another Gemini model, set `GEMINI_MODEL` in the same
file, for example `export GEMINI_MODEL=gemini-3.8-pro`.

## Running the demo

Each command runs in its own terminal, from the repository root:

```bash
temporal server start-dev
```

```bash
redis-server
```

```bash
./src/go/google_adk/scripts/startlocalworker.sh
```

```bash
./src/python/api/startlocalapi.sh google_adk_go
```

```bash
cd frontend && npm install && npm start
```

Open http://localhost:3000 and chat. To approve an account opening as the compliance officer:

```bash
./src/go/google_adk/scripts/localsendcomplianceapproval.sh "<open-account workflow ID>"
```

[docs/temporal.md](docs/temporal.md) covers the details, including the Java worker, claim check, the codec
server and Temporal Cloud. [docs/standalone.md](docs/standalone.md) covers the command-line chat.

## Demo data

The JSON files in [data/](../../../data) (beneficiaries, clients, linked bank accounts and investments) are the
system of record, shared by every port. The data store finds them by looking for `data/clients.json` in the
current folder and its parents (`DATA_DIR` overrides it). Client `123` is Don Doe, of 123 Main Street, with
Checking, Savings and 401K accounts and a linked bank account holding $250,000. The demo changes these files, and
they are tracked by git, so reset them from the repository root with:

```bash
git checkout data/
```

## Tests

From `src/go`:

```bash
go test ./...
```

The default tests live next to the code they test (`*_test.go`), as is usual in Go, and need no model key, Redis
or running Temporal service. The live tests call Gemini; see [docs/temporal.md](docs/temporal.md#tests).

## Layout

The Go code follows Go conventions (`cmd/` for programs, `internal/` for packages) rather than the Python ports'
`standalone/` and `durable/` folders. This table maps one to the other:

| Path | Holds | Python ports |
|---|---|---|
| [cmd/worker](cmd/worker) | The Temporal worker | `durable/run_worker.py` |
| [cmd/cli](cmd/cli), [internal/standalone](internal/standalone) | The standalone command-line chat | `standalone/` |
| [cmd/openaccount](cmd/openaccount) | The open-account runner | `durable/run_open_account_workflow.py` |
| [cmd/compliance](cmd/compliance) | Sends compliance approval | `durable/run_send_compliance_approval.py` |
| [cmd/codecserver](cmd/codecserver) | The claim-check codec server | `durable/codec_server.py` |
| [internal/workflows](internal/workflows) | The chat and open-account workflows, and the agents' tools | `durable/workflows/` |
| [internal/activities](internal/activities) | The activities | `durable/activities/` |
| [internal/agents](internal/agents), [internal/prompts](internal/prompts) | The agent tree and prompts, shared by both versions | `prompts/` |
| [internal/llm](internal/llm) | The chaos-aware Gemini model | |
| [internal/config](internal/config) | Settings: task queues, model, Temporal client options | |
| [scripts](scripts) | Start scripts | the `.sh` files in `durable/` |
| [tests](tests) | Live tests | `tests/live_*` |

The framework-free packages are in [`src/go/internal/common`](../internal/common): `chaos` (failure
injection), `claimcheck` (the claim-check codec), `data` (the data store), `domain` (payloads), `eventstream`
(the Redis event stream the UI reads), `redisx` (Redis settings) and `testfixtures` (the test copy of the demo
data).
