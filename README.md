# Wealth Management Agent Demo

A multi-agent banking chat that shows what Temporal adds to an agent framework, built with eight frameworks in three languages. Each port has a standalone version (the framework alone) and a Temporal version (every model and tool call durable).

## Layout

```
data/                 Demo data (system of record). Reset: git checkout data/
testdata/             Committed seed copy used by all tests
docs/                 Docs; images/ holds the README images
frontend/             The one shared React app
contracts/            (optional) Language-neutral Temporal names, prompt lines, chaos flags
interop/
  open_account/java/  Java OpenInvestmentAccountWorkflow, works with every port
scripts/              Settings files every port's scripts source (model keys, cloud env, claim check)
src/<language>/
  common/             Code shared by that language's ports and its API (no agent framework)
  api/                REST API for the front end: works with every port, has its own dependency file
  <framework>/        One port, with its own dependency file:
    standalone/       Framework-only CLI chat (was <x>_supervisor/)
    durable/          Temporal version: workflows, activities, worker, scripts (was temporal_supervisor/)
    prompts/          The agents' prompts (framework-specific)
    <x>_agents/       (optional) Agent code both versions use, e.g. pyai/pyai_agents
    tests/
```

## Ports

Four ports have been imported so far; the other folders hold a placeholder README.

| Port | Language | Folder | Original repo |
|---|---|---|---|
| OpenAI Agents SDK (reference, imported) | Python | `src/python/openai_agents` | temporal-sa/oai-temporal-wealth-management |
| Google ADK (imported) | Python | `src/python/google_adk` | temporal-sa/adk-wealth-management |
| Pydantic AI (imported) | Python | `src/python/pyai` | temporal-sa/pyai-wealth-management |
| Strands Agents (imported) | Python | `src/python/strands_agents` | temporal-sa/strands-wealth-management |
| Pure Python (LiteLLM) | Python | `src/python/pure` | temporal-sa/pure-wealth-management |
| Vercel AI SDK | TypeScript | `src/typescript/vercel_ai` | temporal-sa/vai-wealth-management |
| Google ADK | TypeScript | `src/typescript/google_adk` | temporal-sa/adk-ts-wealth-management |
| Google ADK | Go | `src/go/google_adk` | temporal-sa/adk-go-wealth-management |

## Adding an integration

Create `src/<language>/<framework>/` with `standalone/`, `durable/`, `tests/` and its own dependency file. Don't name the folder after the library's import name (for example `pydantic_ai` or `strands`), so it can never hide the real library on `sys.path`. Reuse that language's `common/` and `api/`, and match the Temporal contracts so the Java worker and shared scripts work unchanged. For a Python port, add it to `src/python/api/frameworks.py` (its task queue and chat workflow ID prefix) so `./startlocalapi.sh <ai-framework>` serves it.

## Open decisions before migrating code

- **Task queues:** the OpenAI Agents port defaults to `Supervisor`, the Pydantic AI port to `PY-AI-Supervisor`, the Strands Agents port to `wealth-management-strands` and the Google ADK port to `ADK-Supervisor`, so they can run at once. The shared API requires the AI framework as an argument (`./startlocalapi.sh pyai`, `./startlocalapi.sh strands_agents`, `./startlocalapi.sh google_adk`; see `src/python/api/frameworks.py`); the Java worker defaults to `Supervisor`, so start it with `TEMPORAL_TASK_QUEUE` set to the port's queue. Decide whether every port gets its own default.
- **Hosting:** the Python ADK repo's latest commit (temporal-sa/adk-wealth-management#11) made it hostable for many users at once: a session cookie issued by the API, chat workflow IDs picked by the API, chaos flags and sample data per browser session in Redis, a Redis password or URL, a one-hour idle timeout, and a Docker build. The import stops at the commit before it (d85b5d3). Decide whether to bring hosting into the shared API, web app and `common` code for every port.
- **History:** import each repo the way the first two were: on a branch, `git mv` its files into place in rename-only commits, remove the files the monorepo already shares, then merge with `--allow-unrelated-histories`. The ports started from the same layout, so `git log --follow` on a moved file can show commits from more than one port; `git log <path-in-the-original-repo>` on the import's second parent shows one port's history.
