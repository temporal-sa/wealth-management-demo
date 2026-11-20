# Wealth Management Agent Demo

A multi-agent banking chat that shows what Temporal adds to an agent framework, built with eleven frameworks in four languages. Each framework has a standalone version (the framework alone) and a Temporal version (every model and tool call durable).

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
| [LangGraph](src/python/langgraph_agents/README.md) | Python | `src/python/langgraph_agents` |
| [Vercel AI SDK](src/typescript/vercel_ai/README.md) | TypeScript | `src/typescript/vercel_ai` |
| [Google ADK](src/typescript/google_adk/README.md) | TypeScript | `src/typescript/google_adk` |
| [Strands Agents](src/typescript/strands_agents/README.md) | TypeScript | `src/typescript/strands_agents` |
| [Google ADK](src/go/google_adk/README.md) | Go | `src/go/google_adk` |
| [Spring AI](src/java/spring_ai/README.md) | Java | `src/java/spring_ai` |

## Adding an integration

1. **Create the framework's folder,** `src/<language>/<framework>/`, with `standalone/`, `durable/`, `tests/` and its
   own dependency file. Don't name the folder after the library's import name (for example `pydantic_ai` or
   `strands`), so it can never hide the real library on `sys.path`.
   - **TypeScript:** add the folder to `"workspaces"` in `src/typescript/package.json`. The TypeScript code is
     one set of npm workspaces with one `node_modules` and one Temporal SDK version.
   - **Go:** the framework belongs to the one Go module, `src/go/go.mod`, and keeps Go conventions inside its folder
     (`cmd/`, `internal/`, `scripts/`).
   - **Java:** the framework is its own Gradle project with its own wrapper (see `src/java/spring_ai`). Java has no
     shared `common/` folder: Spring AI's `common/` package has Java versions of the shared pieces to copy.
2. **Reuse the shared code:** that language's `common/` (data managers, Redis event stream, chaos flags, claim
   check, client settings), the demo data in `data/`, and the settings files in `scripts/`. Worker and approval
   scripts `cd` to their own folder and source `scripts/*.sh`, so they run from anywhere.
3. **Keep the Temporal contracts:** the same workflow, signal, query, update and activity names and payloads as
   the other frameworks (see any framework's "Temporal contracts" section). The Python API, the web UI and the Java worker
   then work unchanged.
4. **Give the framework its own task queue,** `<short name>-Supervisor`, with model calls on `<queue>-llm`, and turn a
   worker script argument of `java` into `<queue>-open-account` using the shared rule (`common/task_queues.py`,
   `common/task-queues.ts`, or the Go framework's `internal/config`). See [Task queues](#task-queues).
5. **Register it with the API:** add the framework to `src/python/api/frameworks.py` (its name, label, language, short
   label, task queue and chat workflow ID prefix) and to `EVERY_FRAMEWORK` in `src/python/api/tests/test_api.py`, so
   `./src/python/api/startlocalapi.sh <ai-framework>` serves it. One API serves every framework, whatever its language.
   The web UI needs no change: its sidebar lists every framework the API serves, grouped by language (a new language
   gets its own group), and labels it with the short label.
6. **Add it to `scripts/startdemo.sh`:** its worker folder in `worker_dir` and its model key file in `key_file`. The
   worker folder needs `startlocalworker.sh` and `startcloudworker.sh`, which `startdemo.sh` runs with no arguments.
7. **Document it** like the other frameworks:
   - The framework's `README.md`: what it is, prerequisites, setup and the model key, running the demo, tests, layout.
   - Its Temporal README (`durable/README.md`), with the same sections as the other frameworks' Temporal READMEs.
   - Its images in `docs/images/<folder>/`: `application-architecture.png`, the three web UI screenshots
     (`ux-waiting-kyc.png`, `ux-waiting-compliance-review.png`, `ux-open-account-complete.png`) and
     `temporal-ui-open-account.png`.
8. **List it** in this README's [Frameworks](#frameworks) and [Task queues](#task-queues) tables, and in the API, web UI
   (`frontend/README.md`), Java worker and `scripts/` READMEs (including the framework list in `startdemo.sh`'s usage
   comment).
9. **Test it:** the framework's unit tests, an end-to-end chat through the API and web UI that opens an account through
   KYC and compliance approval, and the same with the Java worker (`startlocalworker.sh java`). Also start it with
   `scripts/startdemo.sh all`: it should appear in the sidebar beside the others, and
   `scripts/startdemo.sh restart <ai-framework>` should restart its worker.

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
| LangGraph | `langgraph_agents` | `LangGraph-Supervisor` |
| Vercel AI SDK (TypeScript) | `vercel_ai` | `VAI-Supervisor` |
| Google ADK (TypeScript) | `google_adk_ts` | `ADK-TS-Supervisor` |
| Strands Agents (TypeScript) | `strands_agents_ts` | `Strands-TS-Supervisor` |
| Google ADK (Go) | `google_adk_go` | `ADK-Go-Supervisor` |
| Spring AI (Java) | `spring_ai` | `SpringAI-Supervisor` |

- **The API:** `./src/python/api/startlocalapi.sh <ai-framework>` starts chats on that framework's queue (see
  `src/python/api/frameworks.py`). Several frameworks separated by commas, or `all`, are all listed in the web UI's sidebar.
  With one framework, `TEMPORAL_TASK_QUEUE` overrides its queue; the worker and the API must then agree.
- **The Java worker:** start the framework's worker with the argument `java` (for example
  `src/python/pure/durable/startlocalworker.sh java`), then the Java worker with that framework's queue
  (`TEMPORAL_TASK_QUEUE=Pure-Supervisor interop/open_account/java/startlocalworker.sh`). Each framework's account
  openings go to its own `<queue>-open-account`, so several frameworks can each have a Java worker at once. The Java
  worker has no default queue. `scripts/startdemo.sh --java <ai-framework>` does all of this in one terminal. The rule that turns `java` into the queue name is in `common/task_queues.py`,
  `common/task-queues.ts`, the Go framework's `internal/config` and the Java worker's `ServerInfo`.

## Sharing one demo

Several people can use one running copy of the demo at once, each in their own browser. The API gives every browser a
session (a cookie) and starts its chats with workflow IDs that carry it, so every activity knows whose chat it is
working for. See [Browser sessions](src/python/api/README.md#browser-sessions) in the API README for the details.

**Always separate per browser:**

- **Chats.** Another browser can't read, send to, approve or end your chat: the API answers 404.
- **Chaos flags.** A flag you turn on in the chaos panel fails only your browser's chats, in any framework, and the
  panel lists only your failures.

**The sample bank data** (client 123's details, accounts, beneficiaries and funding) depends on `DEMO_DATA_STORE`:

| `DEMO_DATA_STORE` | Two browsers using client 123 | `data/*.json` | Reset |
|---|---|---|---|
| `file` (default) | Share the same client: an account opened in one shows up in the other, and their changes can overwrite each other | Changed by every demo run | `git checkout data/` |
| `redis` | Each gets its own copy, starting from the files: an account opened in one never shows up in the other | Never changed | A new browser session starts from the files again; a copy expires a day after its last change |

`file` suits one presenter. For a shared demo, set `DEMO_DATA_STORE=redis` where the **workers** run, before starting
them, for example `export DEMO_DATA_STORE=redis` in each worker's terminal. The workers read and write the data; the
API doesn't, so it needs no setting.

**What counts as one browser:** the session lives in the browser's cookie. Tabs and windows of the same browser
profile share a session, and so the same copy of the data. Another browser, a private window or another profile gets
a new session; so does clearing cookies. The web UI's frameworks are one session too. Restarting the API or the
workers doesn't change anyone's session. Workflows
started without the web UI (the scripts, the CLI, the tests) use a shared `default` session.

## Open decisions before migrating code

- **Hosting:** the Python ADK repo's latest commit (temporal-sa/adk-wealth-management#11) made it hostable for many
  users at once. The import stops at the commit before it (d85b5d3).
  - *Brought in, for every framework:* a Redis password or `REDIS_URL` (and event streams that expire a day after
    their last event), the Gemini model from `GEMINI_MODEL`, an "Approve compliance review" button in the web UI,
    and chats that end after an hour idle. Not from that commit, but related: claim check payloads expire in Redis
    after 7 days (`CLAIM_CHECK_TTL_SECONDS`).
  - *Left as is, by choice:* the "Bug in workflow code" chaos switch healing paused openings when turned off.
    Fixing the code and restarting the worker stays the point of that scenario.
  - *Also brought in, multi-user:* the API gives each browser a session cookie and picks chat workflow IDs that carry
    it (its routes are under `/api`, proxied by the web UI's dev server), chaos flags are per browser session, and
    `DEMO_DATA_STORE=redis` gives each session its own copy of the sample data. See
    [Sharing one demo](#sharing-one-demo). It differs from that commit in three ways:
    - Chat IDs keep the framework's prefix (`<prefix>session-<id>-chat-<id>`) instead of starting with the task queue.
    - Redis keys are scoped by session only (`chaos:<session>:…`, `data:<session>:<name>`), not by task queue too.
      So a browser's chaos flags and data follow it across frameworks, but two separate deployments sharing one Redis
      would share the `default` session that scripts and tests use.
    - The approve button's endpoint finds a chat's waiting openings by workflow ID instead of through a new query on
      the chat workflow.
  - *Still to decide:* deployment (a Docker build, claim check payloads in S3, and a `/codec` endpoint on the API).
- **Java worker:** brought in from the Pure Python repo's copy of the Java worker (temporal-sa/pure-wealth-management
  at 8470bdc): a Temporal Cloud API-key profile (`application-tc-apikey.yaml`, chosen by `startcloudworker.sh` when
  `TEMPORAL_API_KEY` is set), unit tests for the claim check codec (with a clear error for a missing payload, and no
  payload contents in the log), `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` in the local profile, and startup log lines.
- **One UI for every framework:** done. Start the API with several frameworks (`startlocalapi.sh strands_agents,vercel_ai`)
  or `all`, and the web UI lists them in a sidebar grouped by language, each with its own live chat. See
  [Several frameworks at once](src/python/api/README.md#several-frameworks-at-once). Notes:
  - *Queue names are a contract.* The API's list in `src/python/api/frameworks.py` is the only thing that maps a framework
    to a queue, so keep each framework's default queue. With several frameworks, `TEMPORAL_TASK_QUEUE` and
    `CHAT_WORKFLOW_ID_PREFIX` are ignored.
  - *Only starting a chat needs the framework.* Sending a message, approving, ending a chat and reading its history find
    the framework from the chat's workflow ID prefix.
  - *A framework without a worker is greyed out.* The API asks Temporal whether a worker polls the framework's chat queue
    (`GET /api/config`). It doesn't check `<queue>-llm` or `<queue>-open-account`, and Temporal keeps listing a stopped
    worker for a few minutes.
  - *Still one Java worker per framework.* One Java worker could poll every `<queue>-open-account` and call the
    activities on the queue name without `-open-account`; not done.
  - *Shared state.* All the chats are one browser session, so a chaos flag affects every framework's chat, and they all
    see the same sample data: an account opened in one framework's chat shows up in the others.
  - *Running it:* `scripts/startdemo.sh <frameworks>` starts the frameworks' workers, the API and the web UI in one
    terminal, after checking Temporal and Redis are up (see [`scripts/README.md`](scripts/README.md#start-the-demo-with-one-command)).
    It doesn't start the Java worker.
- **History:** import each repo the way the first two were: on a branch, `git mv` its files into place in rename-only commits, remove the files the monorepo already shares, then merge with `--allow-unrelated-histories`. The frameworks started from the same layout, so `git log --follow` on a moved file can show commits from more than one framework; `git log <path-in-the-original-repo>` on the import's second parent shows one framework's history.
