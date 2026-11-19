# Wealth Management Agent Example using Google ADK for Go

A multi-agent banking chat that shows what Temporal adds to an agent framework. It is the Go port
of the Wealth Management demo, built with the [Google Agent Development Kit for Go](https://google.github.io/adk-docs/)
and Temporal's [Go integration for Google ADK](https://docs.temporal.io/develop/go/integrations/google-adk)
(`go.temporal.io/googleadk`).

A customer can:

* list, add and delete **beneficiaries**;
* list, open and close **investment accounts**.

Opening an account starts a child workflow with KYC (the customer confirms their details), a
human compliance approval and a saga that creates, funds and registers the account, rolling back if
a step fails.

The demo comes in two versions:

| Version | What it is | README |
|---|---|---|
| Temporal | Every model call and tool call is a durable Temporal activity. A web UI, a chaos panel that injects failures, and the account-opening workflow. | [docs/temporal.md](docs/temporal.md) |
| Standalone | The same agents with Google ADK alone, as a command-line chat. No KYC, compliance review or saga. | [docs/standalone.md](docs/standalone.md) |

It has the same chat, workflows, failure scenarios and Temporal contracts (workflow, signal, query,
update and activity names and payloads) as the other ports:

| Port | Framework | Language | Repository |
|---|---|---|---|
| Reference | OpenAI Agents SDK | Python | [temporal-sa/oai-temporal-wealth-management](https://github.com/temporal-sa/oai-temporal-wealth-management) |
| Vercel | Vercel AI SDK | TypeScript | [temporal-sa/vai-wealth-management](https://github.com/temporal-sa/vai-wealth-management) |
| ADK | Google ADK | Python | [temporal-sa/adk-wealth-management](https://github.com/temporal-sa/adk-wealth-management) |
| Pydantic | Pydantic AI | Python | [temporal-sa/pyai-wealth-management](https://github.com/temporal-sa/pyai-wealth-management) |
| Strands | Strands Agents | Python | [temporal-sa/strands-wealth-management](https://github.com/temporal-sa/strands-wealth-management) |

## Optional components

All three of the PRD's optional components are included:

* the [Java open-account worker](java/README.md), shared with the other ports, which can run
  `OpenInvestmentAccountWorkflow` in place of the Go version;
* the [claim check and codec server](docs/temporal.md#claim-check-optional), which store payloads
  in Redis instead of Temporal's event history;
* the Temporal Cloud scripts: see
  [Running the demo on Temporal Cloud](docs/temporal.md#running-the-demo-on-temporal-cloud).

## Prerequisites

* [Go](https://go.dev/dl/) 1.26.10 or later
* The [Temporal CLI](https://docs.temporal.io/cli#install), for a local Temporal service (tested with 1.9)
* [Redis](https://redis.io/docs/latest/operate/oss_and_stack/install/) 7 or later, on localhost:6379
* [Node.js](https://nodejs.org/en/download) 18 or later, with npm, for the web UI
* A [Gemini API key](https://aistudio.google.com/apikey)
* Optional, for the Java open-account worker: [JDK 25](https://adoptium.net/)

## Set up your Gemini API key

The default model is **Gemini `gemini-3.8-flash`**, the same as the Python ADK port. Copy the example
file and put your key in it:

```bash
cp setgeminikey.example setgeminikey.sh
```

Then edit `setgeminikey.sh`. It is git-ignored: never commit a real key. To use another Gemini model,
set `GEMINI_MODEL` in the same file, for example `export GEMINI_MODEL=gemini-3.8-pro`.

## Getting started

* To run the Temporal version with the web UI, follow [docs/temporal.md](docs/temporal.md).
* To try the agents on their own, follow [docs/standalone.md](docs/standalone.md).

## Demo data

The JSON files in [data/](data) (beneficiaries, clients, linked bank accounts and investments) are the
system of record. Client `123` is Don Doe, of 123 Main Street, with Checking, Savings and 401K
accounts and a linked bank account holding $250,000. The demo changes these files, and they are
tracked by git, so reset them with:

```bash
git checkout data/
```

## Repository layout

The Go code follows Go conventions (`cmd/` for programs, `internal/` for packages) rather than the
Python ports' `src/` layout. This table maps one to the other:

| Path | Holds | Python ports |
|---|---|---|
| [cmd/worker](cmd/worker) | The Temporal worker | `src/temporal_supervisor/run_worker.py` |
| [cmd/api](cmd/api), [internal/api](internal/api) | The REST API for the web UI | `src/api/` |
| [cmd/cli](cmd/cli), [internal/standalone](internal/standalone) | The standalone command-line chat | `src/adk_supervisor/` |
| [cmd/openaccount](cmd/openaccount) | The open-account runner | `src/temporal_supervisor/run_open_account_workflow.py` |
| [cmd/compliance](cmd/compliance) | Sends compliance approval | `src/temporal_supervisor/run_send_compliance_approval.py` |
| [cmd/codecserver](cmd/codecserver), [internal/claimcheck](internal/claimcheck) | The claim-check codec and its codec server | `src/temporal_supervisor/claim_check/`, `codec_server/` |
| [internal/workflows](internal/workflows) | The chat and open-account workflows, and the agents' tools | `src/temporal_supervisor/workflows/` |
| [internal/activities](internal/activities) | The activities | `src/temporal_supervisor/activities/` |
| [internal/agents](internal/agents), [internal/prompts](internal/prompts) | The agent tree and prompts, shared by both versions | `src/common/agent_constants.py` |
| [internal/chaos](internal/chaos), [internal/llm](internal/llm) | Failure injection, and the chaos-aware Gemini model | `src/temporal_supervisor/chaos.py`, `model_config.py` |
| [internal/data](internal/data), [internal/eventstream](internal/eventstream), [internal/redisx](internal/redisx), [internal/config](internal/config), [internal/domain](internal/domain) | Data managers, Redis event stream, settings and payloads | `src/common/` |
| [scripts](scripts) | Start scripts | the `.sh` files in `src/` |
| [frontend](frontend) | Copy of the shared React app | `src/frontend/` |
| [tests](tests) | Live tests | `tests/live_*` |
| [java](java) | Optional Java open-account worker, copied unchanged from the reference | `java/` |
| [data](data) | Demo data, unchanged from the reference | `data/` |

The default tests live next to the code they test (`*_test.go`), as is usual in Go.
