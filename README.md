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
  api/                (Python only) REST API for the front end: serves every port, in any language, has its own dependency file
  <framework>/        One port, with its own dependency file:
    standalone/       Framework-only CLI chat (was <x>_supervisor/)
    durable/          Temporal version: workflows, activities, worker, scripts (was temporal_supervisor/)
    prompts/          The agents' prompts (framework-specific)
    <x>_agents/       (optional) Agent code both versions use, e.g. pyai/pyai_agents
    tests/
```

## Ports

All eight ports have been imported.

| Port | Language | Folder | Original repo |
|---|---|---|---|
| OpenAI Agents SDK (reference, imported) | Python | `src/python/openai_agents` | temporal-sa/oai-temporal-wealth-management |
| Google ADK (imported) | Python | `src/python/google_adk` | temporal-sa/adk-wealth-management |
| Pydantic AI (imported) | Python | `src/python/pyai` | temporal-sa/pyai-wealth-management |
| Strands Agents (imported) | Python | `src/python/strands_agents` | temporal-sa/strands-wealth-management |
| Pure Python (LiteLLM) (imported) | Python | `src/python/pure` | temporal-sa/pure-wealth-management |
| Vercel AI SDK (imported) | TypeScript | `src/typescript/vercel_ai` | temporal-sa/vai-wealth-management |
| Google ADK (imported) | TypeScript | `src/typescript/google_adk` | temporal-sa/adk-ts-wealth-management |
| Google ADK (imported) | Go | `src/go/google_adk` | temporal-sa/adk-go-wealth-management |

## Adding an integration

Create `src/<language>/<framework>/` with `standalone/`, `durable/`, `tests/` and its own dependency file. Don't name the folder after the library's import name (for example `pydantic_ai` or `strands`), so it can never hide the real library on `sys.path`. Reuse that language's `common/`, and match the Temporal contracts so the Python API, the Java worker and shared scripts work unchanged. One API, `src/python/api`, serves every port, whatever its language: add the port to `src/python/api/frameworks.py` (its task queue and chat workflow ID prefix) so `./startlocalapi.sh <ai-framework>` serves it. For a TypeScript port, also add it to `"workspaces"` in `src/typescript/package.json` (the TypeScript code is one set of npm workspaces with one `node_modules`). A Go port belongs to the one Go module, `src/go/go.mod`, and keeps Go conventions inside its folder (`cmd/`, `internal/`, `scripts/`).

## Task queues

Every port has its own default chat task queue, `<short name>-Supervisor`, so the ports can run against one
Temporal service at once. Its model calls run on `<queue>-llm`, and with the Java worker its account openings
run on `<queue>-open-account`.

| Port | AI framework (API argument) | Task queue |
|---|---|---|
| OpenAI Agents SDK | `openai_agents` | `OAI-Supervisor` |
| Pydantic AI | `pyai` | `PYAI-Supervisor` |
| Strands Agents | `strands_agents` | `Strands-Supervisor` |
| Google ADK (Python) | `google_adk` | `ADK-Supervisor` |
| Pure Python (LiteLLM) | `pure` | `Pure-Supervisor` |
| Vercel AI SDK (TypeScript) | `vercel_ai` | `VAI-Supervisor` |
| Google ADK (TypeScript) | `google_adk_ts` | `ADK-TS-Supervisor` |
| Google ADK (Go) | `google_adk_go` | `ADK-Go-Supervisor` |

- **The API:** `./src/python/api/startlocalapi.sh <ai-framework>` starts chats on that framework's queue (see
  `src/python/api/frameworks.py`). `TEMPORAL_TASK_QUEUE` overrides a port's queue; the worker and the API
  must then agree.
- **The Java worker:** start the port's worker with the argument `java` (for example
  `src/python/pure/durable/startlocalworker.sh java`), then the Java worker with that port's queue
  (`TEMPORAL_TASK_QUEUE=Pure-Supervisor interop/open_account/java/startlocalworker.sh`). Each port's account
  openings go to its own `<queue>-open-account`, so several ports can each have a Java worker at once. The Java
  worker has no default queue. The rule that turns `java` into the queue name is in `common/task_queues.py`,
  `common/task-queues.ts`, the Go port's `internal/config` and the Java worker's `ServerInfo`.

## Open decisions before migrating code

- **Hosting:** the Python ADK repo's latest commit (temporal-sa/adk-wealth-management#11) made it hostable for many users at once: a session cookie issued by the API, chat workflow IDs picked by the API, chaos flags and sample data per browser session in Redis, a Redis password or URL, a one-hour idle timeout, and a Docker build. The import stops at the commit before it (d85b5d3). Decide whether to bring hosting into the shared API, web app and `common` code for every port.
- **Java worker:** the Pure Python repo's copy of the Java worker (temporal-sa/pure-wealth-management at 8470bdc) has things the shared one in `interop/open_account/java` doesn't: a Temporal Cloud API-key profile (`application-tc-apikey.yaml`, chosen by `startcloudworker.sh` when `TEMPORAL_API_KEY` is set) and unit tests for the claim check codec. The import kept the shared worker. Decide whether to bring those into it.
- **History:** import each repo the way the first two were: on a branch, `git mv` its files into place in rename-only commits, remove the files the monorepo already shares, then merge with `--allow-unrelated-histories`. The ports started from the same layout, so `git log --follow` on a moved file can show commits from more than one port; `git log <path-in-the-original-repo>` on the import's second parent shows one port's history.
