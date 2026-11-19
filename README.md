# Wealth Management Agent Demo

A multi-agent banking chat that shows what Temporal adds to an agent framework, built with eight frameworks in three languages. Each framework has a standalone version (the framework alone) and a Temporal version (every model and tool call durable).

## Layout

```
data/                 Demo data (system of record). Reset: git checkout data/
testdata/             Committed seed copy used by all tests
docs/                 Docs; images/ holds the README images
frontend/             The one shared React app
contracts/            (optional) Language-neutral Temporal names, prompt lines, chaos flags
interop/
  open_account/java/  Java OpenInvestmentAccountWorkflow, works with every framework
scripts/              Settings files every framework's scripts source (model keys, cloud env, claim check)
src/<language>/
  common/             Code shared by that language's frameworks and the API (no agent framework)
  api/                (Python only) REST API for the front end: serves every framework, in any language, has its own dependency file
  <framework>/        One framework, with its own dependency file:
    standalone/       Framework-only CLI chat (was <x>_supervisor/)
    durable/          Temporal version: workflows, activities, worker, scripts (was temporal_supervisor/)
    prompts/          The agents' prompts (framework-specific)
    <x>_agents/       (optional) Agent code both versions use, e.g. pyai/pyai_agents
    tests/
```

## Frameworks

| Framework | Language | Folder |
|---|---|---|
| [OpenAI Agents SDK](src/python/openai_agents/README.md) (reference) | Python | `src/python/openai_agents` |
| [Google ADK](src/python/google_adk/README.md) | Python | `src/python/google_adk` |
| [Pydantic AI](src/python/pyai/README.md) | Python | `src/python/pyai` |
| [Strands Agents](src/python/strands_agents/README.md) | Python | `src/python/strands_agents` |
| [Pure Python (LiteLLM)](src/python/pure/README.md) | Python | `src/python/pure` |
| [Vercel AI SDK](src/typescript/vercel_ai/README.md) | TypeScript | `src/typescript/vercel_ai` |
| [Google ADK](src/typescript/google_adk/README.md) | TypeScript | `src/typescript/google_adk` |
| [Google ADK](src/go/google_adk/README.md) | Go | `src/go/google_adk` |

## Adding an integration

1. **Create the framework's folder,** `src/<language>/<framework>/`, with `standalone/`, `durable/`, `tests/` and its
   own dependency file. Don't name the folder after the library's import name (for example `pydantic_ai` or
   `strands`), so it can never hide the real library on `sys.path`.
   - **TypeScript:** add the folder to `"workspaces"` in `src/typescript/package.json`. The TypeScript code is
     one set of npm workspaces with one `node_modules` and one Temporal SDK version.
   - **Go:** the framework belongs to the one Go module, `src/go/go.mod`, and keeps Go conventions inside its folder
     (`cmd/`, `internal/`, `scripts/`).
2. **Reuse the shared code:** that language's `common/` (data managers, Redis event stream, chaos flags, claim
   check, client settings), the demo data in `data/`, and the settings files in `scripts/`. Worker and approval
   scripts `cd` to their own folder and source `scripts/*.sh`, so they run from anywhere.
3. **Keep the Temporal contracts:** the same workflow, signal, query, update and activity names and payloads as
   the other frameworks (see any framework's "Temporal contracts" section). The Python API, the web UI and the Java worker
   then work unchanged.
4. **Give the framework its own task queue,** `<short name>-Supervisor`, with model calls on `<queue>-llm`, and turn a
   worker script argument of `java` into `<queue>-open-account` using the shared rule (`common/task_queues.py`,
   `common/task-queues.ts`, or the Go framework's `internal/config`). See [Task queues](#task-queues).
5. **Register it with the API:** add the framework to `src/python/api/frameworks.py` (its name, label, task queue and
   chat workflow ID prefix) and to `EVERY_FRAMEWORK` in `src/python/api/tests/test_api.py`, so
   `./src/python/api/startlocalapi.sh <ai-framework>` serves it. One API serves every framework, whatever its language.
6. **Document it** like the other frameworks:
   - The framework's `README.md`: what it is, prerequisites, setup and the model key, running the demo, tests, layout.
   - Its Temporal README (`durable/README.md`), with the same sections as the other frameworks' Temporal READMEs.
   - Its images in `docs/images/<folder>/`: `application-architecture.png`, the three web UI screenshots
     (`ux-waiting-kyc.png`, `ux-waiting-compliance-review.png`, `ux-open-account-complete.png`) and
     `temporal-ui-open-account.png`.
7. **List it** in this README's [Frameworks](#frameworks) and [Task queues](#task-queues) tables, and in the API, web UI
   (`frontend/README.md`), Java worker and `scripts/` READMEs.
8. **Test it:** the framework's unit tests, an end-to-end chat through the API and web UI that opens an account through
   KYC and compliance approval, and the same with the Java worker (`startlocalworker.sh java`).

## Task queues

Every framework has its own default chat task queue, `<short name>-Supervisor`, so the frameworks can run against one
Temporal service at once. Its model calls run on `<queue>-llm`, and with the Java worker its account openings
run on `<queue>-open-account`.

| Framework | API argument | Task queue |
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
  `src/python/api/frameworks.py`). `TEMPORAL_TASK_QUEUE` overrides a framework's queue; the worker and the API
  must then agree.
- **The Java worker:** start the framework's worker with the argument `java` (for example
  `src/python/pure/durable/startlocalworker.sh java`), then the Java worker with that framework's queue
  (`TEMPORAL_TASK_QUEUE=Pure-Supervisor interop/open_account/java/startlocalworker.sh`). Each framework's account
  openings go to its own `<queue>-open-account`, so several frameworks can each have a Java worker at once. The Java
  worker has no default queue. The rule that turns `java` into the queue name is in `common/task_queues.py`,
  `common/task-queues.ts`, the Go framework's `internal/config` and the Java worker's `ServerInfo`.

## Open decisions before migrating code

- **Hosting:** the Python ADK repo's latest commit (temporal-sa/adk-wealth-management#11) made it hostable for many
  users at once. The import stops at the commit before it (d85b5d3).
  - *Brought in, for every framework:* a Redis password or `REDIS_URL` (and event streams that expire a day after
    their last event), the Gemini model from `GEMINI_MODEL`, an "Approve compliance review" button in the web UI,
    and chats that end after an hour idle. Not from that commit, but related: claim check payloads expire in Redis
    after 7 days (`CLAIM_CHECK_TTL_SECONDS`).
  - *Left as is, by choice:* the "Bug in workflow code" chaos switch healing paused openings when turned off.
    Fixing the code and restarting the worker stays the point of that scenario.
  - *Still to decide:* multi-user (a session cookie issued by the API, chat workflow IDs picked by the API, chaos
    flags and sample data per browser session in Redis), and deployment (a Docker build, claim check payloads in S3,
    and a `/codec` endpoint on the API).
- **Java worker:** brought in from the Pure Python repo's copy of the Java worker (temporal-sa/pure-wealth-management
  at 8470bdc): a Temporal Cloud API-key profile (`application-tc-apikey.yaml`, chosen by `startcloudworker.sh` when
  `TEMPORAL_API_KEY` is set), unit tests for the claim check codec (with a clear error for a missing payload, and no
  payload contents in the log), `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` in the local profile, and startup log lines.
- **One UI for every framework:** the plan is one web app where the user picks the AI framework. The task queue names
  already support it; the notes for when that work starts:
  - *Queue names are a contract.* The API's list in `src/python/api/frameworks.py` is the only thing that maps a
    choice to a queue, so keep each framework's default queue. A worker started with another `TEMPORAL_TASK_QUEUE` would
    get no chats unless the API's list changes too.
  - *Only starting a chat needs the queue.* Sending a message, ending a chat and reading its history go to the
    workflow by ID. The API would take the framework on `start-workflow` instead of choosing one at startup (the
    workflow ID prefix already names the framework, so it can check they match), and the UI would read the list of
    frameworks (label, queue, prefix) from the API instead of hard-coding them.
  - *Only offer frameworks that are running.* A chat started for a framework with no worker hangs. With the
    predictable names, the API can ask Temporal whether `<queue>` and `<queue>-llm` have pollers and list only those.
  - *One Java worker could serve every framework.* It would poll every `<queue>-open-account` and call the activities on
    the queue name without `-open-account`, instead of running one Java worker per framework.
  - *Other shared state.* The chaos flags are global in Redis (`chaos:flags`), so a flag affects every framework at
    once, and every framework reads and writes the same `data/*.json`, so openings from different frameworks at the same
    time can overwrite each other's changes (see Hosting: per-session data in Redis would fix both).
- **History:** import each repo the way the first two were: on a branch, `git mv` its files into place in rename-only commits, remove the files the monorepo already shares, then merge with `--allow-unrelated-histories`. The frameworks started from the same layout, so `git log --follow` on a moved file can show commits from more than one framework; `git log <path-in-the-original-repo>` on the import's second parent shows one framework's history.
