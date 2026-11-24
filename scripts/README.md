# Shared scripts

Settings files that every framework's start scripts source, plus scripts that work with any language. Create the `.sh` files from the `.example` files here; only the `.example` files are committed.

| File | Purpose |
|---|---|
| `setoaikey.example` → `setoaikey.sh` | OpenAI API key (`OPENAI_API_KEY`): OpenAI Agents (Python and TypeScript), Pydantic AI and Microsoft Agent Framework (.NET) frameworks. The TypeScript OpenAI Agents and the .NET frameworks also read an optional `OPENAI_MODEL` (default `gpt-4o`) |
| `setgeminikey.example` → `setgeminikey.sh` | Gemini API key (`GEMINI_API_KEY`): Strands Agents (Python and TypeScript), Google ADK (Python, TypeScript and Go), LangGraph, Vercel AI SDK and Spring AI frameworks. All of them also read an optional `GEMINI_MODEL` (default `gemini-3.8-flash`) |
| `setllmkey.example` → `setllmkey.sh` | Pure Python framework: `LLM_MODEL` (a LiteLLM `<provider>/<model>` name) and that provider's key (Anthropic by default; OpenAI or Gemini also work) |
| `setclaimcheck.example` → `setclaimcheck.sh` | Optional claim check: `USE_CLAIM_CHECK`, and where Redis is: host and port, an optional `REDIS_PASSWORD`, or a `REDIS_URL` that wins over them; how long claim-checked payloads are kept (`CLAIM_CHECK_TTL_SECONDS`, default 7 days) |
| `setcloudenv.example` → `setcloudenv.sh` | Temporal Cloud address, namespace, and either an mTLS cert and key or an API key (with an API key, a namespace that also allows mTLS needs the regional `<region>.<cloud>.api.temporal.io:7233` address) |
| `setsplitworkflows.sh` | Sourced by worker scripts: a queue argument moves the open-account workflow onto that queue (e.g. for the Java worker) |
| `startdemo.sh` | Starts the demo for one or more frameworks in one terminal: each framework's worker, the API and the web UI, and with `--java` the Java open-account worker. See [Start the demo with one command](#start-the-demo-with-one-command) |

Other frameworks add their key files here too, so frameworks that use the same provider share one key file.

## Start the demo with one command

`startdemo.sh` starts everything but Temporal and Redis, for one framework, several, or all of them. The web UI lists
them in its sidebar:

```bash
scripts/startdemo.sh strands_agents,vercel_ai,google_adk_go
scripts/startdemo.sh all
scripts/startdemo.sh --cloud all     # Temporal Cloud, with scripts/setcloudenv.sh
scripts/startdemo.sh --java strands_agents   # account openings on the Java worker
scripts/startdemo.sh --experimental          # the experimental frameworks only
scripts/startdemo.sh --experimental all      # all, with the experimental frameworks too
```

`all` leaves out the experimental frameworks, which are built on pre-release Temporal integrations (today the
Microsoft Agent Framework one, `agent_framework_dotnet`). `--experimental` on its own starts just them, and
`--experimental all` adds them to all; naming one also starts it. Each starts with a warning that it's experimental. It needs the .NET 10 SDK, which the script checks only when it starts it.

Start Temporal (for a local demo, `temporal server start-dev`) and Redis first: the script checks that it can reach
them, and that ports 8000 (API) and 3000 (web UI) are free, before it starts anything. Then it runs each framework's
own worker start script (`startlocalworker.sh`, or `startcloudworker.sh` with `--cloud`), the API's start script with
the same frameworks, and `npm start` for the web UI. A framework whose key file is missing (`setoaikey.sh`,
`setgeminikey.sh` or `setllmkey.sh`, see above) is skipped with a warning.

Every line of output is prefixed with where it came from (`[strands_agents] ...`, `[api] ...`, `[webui] ...`) and also
saved to `logs/<name>.log`, replaced on each run. Ctrl-C stops everything the script started.

### Run account openings on the Java worker (`--java`)

With `--java`, the account-opening workflow runs on the shared
[Java open-account worker](../interop/open_account/java/README.md) instead of each framework's own worker:

```bash
scripts/startdemo.sh --java strands_agents,vercel_ai
```

The script builds the Java worker first, then starts one Java worker per framework, named `java-<framework>`
(`[java-strands_agents] ...`, `logs/java-strands_agents.log`). Each serves its framework's task queue: its account
openings run on `<task queue>-open-account`, and its activities (client details, the saga steps) still run on the
framework's own worker, which `--java` starts with `TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT=java`. It needs a JDK (25), and
each Java worker is a JVM of its own, so `--java all` starts nine. It combines with `--cloud`.

### Stop, start or restart one framework's worker

While the demo runs, use a second terminal to stop, start or restart one framework's worker. The others keep running:

```bash
scripts/startdemo.sh stop strands_agents
scripts/startdemo.sh start strands_agents
scripts/startdemo.sh restart strands_agents   # stop and start, for example to load a code fix
```

The worker's output stays in the first terminal (`[strands_agents] *** stopped`, `*** restarting`, `*** starting`),
its log keeps every run, and Ctrl-C there still stops everything. A worker that stops by itself, for example after a
crash, waits for `start` too. The commands work only on workers this script started, by their framework name.
With `--java`, `java-<framework>` names that framework's Java worker, for example
`scripts/startdemo.sh restart java-strands_agents`.

### Demo the "Bug in workflow code" scenario

1. `scripts/startdemo.sh all`, then pick a framework in the web UI.
2. Click **Show chaos panel** and turn on **Bug in workflow code**.
3. Open an account and approve compliance (the **Approve compliance review** button). The account opening pauses: its
   workflow task fails on the bug and Temporal retries it, which the Temporal UI shows on the open-account workflow.
   The other frameworks' chats keep working.
4. Optionally, `scripts/startdemo.sh stop <framework>`: with no worker, the opening simply waits in Temporal.
5. Fix the bug in that framework's open-account workflow. The chaos panel's "Demo scenarios" says where: for the
   Python frameworks, `_welcome_bonus` in `durable/workflows/open_account_workflow.py` (`initial_deposit` →
   `initial_amount`), and each framework has its own copy.
6. `scripts/startdemo.sh restart <framework>` (or `start` after step 4). The worker replays the workflow with the fix,
   and the opening completes in the web UI.
7. Turn the flag off, and `git checkout` the file to put the bug back for the next demo.

With `--java`, the bug is in the Java workflow instead (a `NullPointerException` from `BONUS_RATES` in
`OpenInvestmentAccountWorkflowImpl.java`, see the [Java worker's README](../interop/open_account/java/README.md#bug-in-the-workflow-code-chaos-panel)).
Fix it there, then `scripts/startdemo.sh restart java-<framework>`: the Java worker compiles the fix when it starts.

Order: Temporal and Redis must be up first, because the workers and the API connect when they start. After that the
order doesn't matter: a framework stays greyed out in the sidebar until its worker polls, and the web UI notices within 10 seconds.

The script doesn't start the codec server.
