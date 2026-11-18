# Wealth Management Agent Demo: pure Python

A multi-agent banking chat that shows what Temporal adds to an AI agent. A customer lists, adds
and deletes beneficiaries, and lists, opens and closes investment accounts. Opening an account
starts a child workflow with KYC, a human compliance approval and a saga.

This port uses **no agent framework**. The agents, tools and handoffs are a small agent loop in
plain Python ([src/common/agent_loop.py](src/common/agent_loop.py)), and the model is called
through [LiteLLM](https://docs.litellm.ai/), so you can switch between Anthropic, OpenAI and
Gemini by changing one environment variable. It implements the same demo as the other ports
(see [Related ports](#related-ports)) and keeps their Temporal contracts, so the same web UI,
scripts and compliance tooling work with it.

The demo is implemented twice:

* **[Standalone](src/pure_supervisor/README.md)**: the four agents as a command-line chat,
  with no Temporal. Accounts are opened directly, without KYC, compliance review or a saga.
* **[Temporal](src/temporal_supervisor/README.md)**: the same agent loop running inside a
  workflow, where every model and tool call is a durable activity. Includes the web UI, the
  account-opening child workflow and the chaos panel for failure demos.

## How the agents work without a framework

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

* An **agent** is a name, instructions, a list of tools and a list of agents it can hand off to.
* A **tool** is an async Python function. Its JSON schema is built from its signature.
* A **handoff** is offered to the model as one more tool, `transfer_to_<agent_name>`. When the
  model calls it, the loop switches the active agent and carries on in the same turn, so the
  new agent answers the customer's message without the customer noticing a transfer.
* `run_turn` runs one customer message to completion. It does no I/O of its own: the model call
  and the tools are passed in. The standalone version passes functions that call LiteLLM and the
  data files directly. The Temporal version passes functions that run activities, which makes the
  same loop deterministic workflow code.

## Scenarios

* List, add and delete beneficiaries (delete asks for confirmation first).
* List and close investment accounts (close asks for confirmation first).
* Open an investment account: deposit validation ($100 to $1,000,000), KYC confirmation or
  update of the customer's details, compliance approval from outside the chat, then a saga that
  creates, funds and registers the account, rolling back on failure.
* Failure demos from the UI's chaos panel: tool outage, model outage, model rate limiting,
  custodian rejection (saga rollback), slow saga steps, and a bug in workflow code that is fixed
  by editing one line while the workflow waits. See the
  [Temporal README](src/temporal_supervisor/README.md#failure-scenarios).

## Prerequisites

| Tool | Version used | Needed for |
|------|--------------|------------|
| [Python](https://www.python.org/) | 3.13 | Everything |
| [uv](https://docs.astral.sh/uv/) | 0.13 | Everything |
| [Temporal CLI](https://docs.temporal.io/cli) | 1.9 | Temporal version (local dev server) |
| [Redis](https://redis.io/) | 8 | Temporal version (UI event stream, chaos flags) |
| [Node.js](https://nodejs.org/) | 26 (any LTS from 20 should work) | Web UI |
| [Java JDK](https://adoptium.net/) | 25 | Optional Java open-account worker only |
| A model API key | Anthropic, OpenAI or Gemini | Both versions, and the live tests |

Install the Python dependencies:

```bash
uv sync
```

## Model key setup

Copy the example key file and fill in your key. `setllmkey.sh` is ignored by git.

```bash
cp setllmkey.example setllmkey.sh
```

Every start script sources `setllmkey.sh` if it exists. To use it in your own shell:

```bash
source ./setllmkey.sh
```

### Choosing the model

`LLM_MODEL` is a LiteLLM model name, `<provider>/<model>`. The default is
`anthropic/claude-opus-5-5`. To switch provider, set `LLM_MODEL` and that provider's key in
`setllmkey.sh`:

| Provider | `LLM_MODEL` example | Key variable |
|----------|---------------------|--------------|
| Anthropic (default) | `anthropic/claude-opus-5-5` or `anthropic/claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5` | `OPENAI_API_KEY` |
| Gemini | `gemini/gemini-2.5-pro` | `GEMINI_API_KEY` |

No code changes are needed: LiteLLM translates the same OpenAI-format messages and tools for each
provider. The chaos panel's model failure switches are labeled "LLM", and their descriptions
name the configured model.

LiteLLM is pinned to an exact release that had been out for a few weeks when it was chosen, and
`mcp` is pinned alongside it because that LiteLLM release imports it without declaring it. Review
the release notes before upgrading either.

## Running the demo

Quick start for the Temporal version with the web UI. Each command runs in its own terminal, from
the repository root:

```bash
temporal server start-dev
```

```bash
redis-server
```

```bash
./src/temporal_supervisor/startlocalworker.sh
```

```bash
./src/api/startlocalapi.sh
```

```bash
cd src/frontend && npm install && npm start
```

Open http://localhost:3000 and chat. To approve an account opening as the compliance officer:

```bash
./src/temporal_supervisor/localsendcomplianceapproval.sh <open-account workflow ID>
```

The [Temporal README](src/temporal_supervisor/README.md) covers the details, and the
[standalone README](src/pure_supervisor/README.md) covers the command-line chat.

## Demo data

The JSON files in [data/](data) (beneficiaries, clients, funding accounts, investments) are the
system of record, and the demo changes them. They are tracked by git, so after a demo you can reset
them with:

```bash
git checkout data/
```

Tests and demo scripts rely on client 123 (Don Doe, 123 Main Street), with Checking, Savings and
401K accounts and a $250,000 linked bank account.

## Tests

The default suite needs no model key, no Redis and no running Temporal service. It uses Temporal's
local test server (downloaded on first run), stub activities and a scripted model:

```bash
uv run pytest
```

The live tests call the real model and are not part of the default run. See
[Tests](src/temporal_supervisor/README.md#tests) in the Temporal README.

The web UI has its own smoke test:

```bash
cd src/frontend && npm test -- --watchAll=false
```

## Optional components

This port includes all the optional components of the other ports:

* the [Java open-account worker](java/README.md), which runs the open-account workflow in Java;
* the Temporal Cloud scripts. See
  [Running on Temporal Cloud](src/temporal_supervisor/README.md#running-on-temporal-cloud);
* the Redis claim check and codec server. See
  [Claim check and codec server](src/temporal_supervisor/README.md#claim-check-and-codec-server-optional).

## Repository layout

| Path | Holds |
|------|-------|
| [src/pure_supervisor/](src/pure_supervisor) | Standalone version and its README |
| [src/temporal_supervisor/](src/temporal_supervisor) | Temporal version: workflows, activities, worker, runners, scripts, README |
| [src/api/](src/api) | The API for the web UI and its start script |
| [src/common/](src/common) | The agent loop, agents and prompts, LiteLLM caller, data managers, Redis event stream, chaos flags, claim check codec, Temporal config |
| [src/frontend/](src/frontend) | The shared React web UI |
| [java/](java) | Optional Java open-account worker and its README |
| [data/](data) | Demo data |
| [tests/](tests) | Default tests (`test_*.py`) and live tests (`live_*.py`) |

## Related ports

| Port | Framework | Repository |
|------|-----------|------------|
| Reference | OpenAI Agents SDK | [temporal-sa/oai-temporal-wealth-management](https://github.com/temporal-sa/oai-temporal-wealth-management) |
| Vercel | Vercel AI SDK | [temporal-sa/vai-wealth-management](https://github.com/temporal-sa/vai-wealth-management) |
| ADK | Google Agent Development Kit | [temporal-sa/adk-wealth-management](https://github.com/temporal-sa/adk-wealth-management) |
| Pydantic | Pydantic AI | [temporal-sa/pyai-wealth-management](https://github.com/temporal-sa/pyai-wealth-management) |
| Strands | Strands Agents | [temporal-sa/strands-wealth-management](https://github.com/temporal-sa/strands-wealth-management) |
| Pure Python (this port) | None: plain Python and LiteLLM | [temporal-sa/bare-wealth-management](https://github.com/temporal-sa/bare-wealth-management) |
