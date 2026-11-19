# Wealth Management Agent Example using Pydantic AI Framework

This project demonstrates how to use [Pydantic AI Framework](https://ai.pydantic.dev/) 
with multiple agents working together. It leverages the supervisor pattern to "hand off" work to agents that have specific knowledge of a certain domain. 

You will find a version of just using the Pydantic AI Framework and another version
that leverages [Temporal](https://temporal.io) to wrap the agentic flow with Temporal.

![](../../../docs/images/pyai/architecture.png)

The vanilla Pydantic AI framework version of this example is located [here](standalone/README.md).

The Temporal version of this example is located [here](durable/README.md)

This port was imported from [temporal-sa/pyai-wealth-management](https://github.com/temporal-sa/pyai-wealth-management). It shares `src/python/common`, the [API](../api/README.md), the [web application](../../../frontend/README.md), the [Java worker](../../../interop/open_account/java/README.md) and `data/` with the other ports. Its own code:

| Folder | What it is |
|---|---|
| `standalone/` | The Pydantic AI version without Temporal |
| `durable/` | The Temporal version: workflows, activities, worker and scripts |
| `pyai_agents/` | The agents and their tools, used by both versions |
| `prompts/` | The agents' instructions |
| `tests/` | The port's tests |

Its chat workflows run on the `PYAI-Supervisor` task queue by default, so its worker can run next to another port's. Start the API with `./startlocalapi.sh pyai`, which uses that queue and names each chat workflow `pyai-temporal-agent-<random>`, and the Java worker with `TEMPORAL_TASK_QUEUE=PYAI-Supervisor`.

Scenarios currently implemented include:
* Add Beneficiary - add a new beneficiary to your account
* List Beneficiaries - shows a list of beneficiaries and their relationship to the account owner
* Delete Beneficiary - delete a beneficiary from your account
* Open Investment Account - in the Temporal version, opens a new investment account by starting a child workflow. The agent asks you to confirm or update your details (KYC), then the account waits for a compliance approval signal before it is created. The account opening workflow can run in Python (default) or Java. The standalone Pydantic AI version simply adds the account (no KYC, compliance approval or saga)
* List Investments - shows a list of accounts and their current balances
* Close Investment Account - closes an investment account
* Off-topic questions - questions that aren't about beneficiaries or investment accounts are politely declined by the supervisor agent (handled in the agents' prompts)

You can run through the scenarios with the Temporal version using a [Web Application](../../../frontend/README.md)
that talks to the [API](../api/README.md).

The Temporal version also has a chaos panel that injects failures (API and LLM outages, rate limits, a saga rollback and a bug in workflow code) to show how Temporal handles them. See
[Failure scenarios](durable/README.md#failure-scenarios-chaos-panel).

## Prerequisites
* [uv](https://docs.astral.sh/uv/) - Python package and project manager
* Python 3.14 or later (`requires-python` in `pyproject.toml`). `uv sync` can install it for you
* [OpenAI API Key](https://platform.openai.com/api-keys) - Your key to accessing OpenAI's LLM
* [Temporal CLI](https://docs.temporal.io/cli#install) - Local Temporal service (Temporal version only)
* [Redis](https://redis.io/downloads/) - Stores conversation history and the chaos panel flags (Temporal version only)
* [Node.js](https://nodejs.org/en/download) and npm - Only needed for the [Web Application](../../../frontend/README.md)
* [Java](https://adoptium.net/) JDK 25 (optional) - Only needed for the [Java Open Investment Account Workflow](../../../interop/open_account/java/README.md). The Gradle wrapper (Gradle 9.8.2) is included, so you don't need to install Gradle

## Set up Python Environment
```bash
cd src/python/pyai
uv sync
```

## Set up your OpenAI API Key
 
From the repository root:

```bash
cp scripts/setoaikey.example scripts/setoaikey.sh
chmod +x scripts/setoaikey.sh
```

Now edit scripts/setoaikey.sh and paste in your OpenAI API Key.
It should look something like this:
```text
export OPENAI_API_KEY=sk-proj-....
```

The start scripts source `scripts/setoaikey.sh`. Every port that uses OpenAI shares it.

## Getting Started

See the Pydantic AI Framework version [here](standalone/README.md)
and the Temporal version of this example [here](durable/README.md).

## Resetting the demo data

Opening and closing accounts and adding or deleting beneficiaries change the JSON files in `data/`.
To put them back to their original state, from the repository root:

```bash
git checkout data/
```

## Running the tests

```bash
cd src/python/pyai
uv run pytest
```

The tests need no OpenAI API key or Redis. Some run against a local Temporal test server, which is
downloaded automatically on the first run. See the [Temporal version](durable/README.md#tests)
for the Java and frontend tests, and for the live tests against the real OpenAI model
(`source ../../../scripts/setoaikey.sh && uv run pytest tests/live_agent_handoffs.py tests/live_repeat_opening.py -s`),
which call the paid API and are not part of the default run.
