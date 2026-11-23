# Hosting plan: the Temporal FieldKit platform, phase 1

Goal: run the wealth management demo as one hosted, shared demo on the Temporal FieldKit platform
(`temporal-sa/temporal-fieldkit-platform`), with the 12 stable frameworks in one web app, on Temporal Cloud. Phase 1
leaves out the claim check.

## Status

Done in this repository:

- **The API** serves the built web app at `/` (`WEB_APP_DIR`), answers `GET /api/health`, and with `DEMO_HOSTED=true`
  leaves the "Bug in workflow code" switch out (`src/python/api/main.py`, with tests).
- **The images**: ten Dockerfiles in `docker/` (web, six Python workers, one TypeScript image for four workers, Go,
  Spring AI) and a root `.dockerignore`.
- **`docker-compose.yml`** in the hosted shape, with a profile per framework. Tested: all twelve workers start from
  the environment alone; a chat in every framework lists the accounts; account openings complete through KYC, the
  approve button and Complete in OpenAI Agents (Python), Vercel AI SDK, Google ADK (Go) and Spring AI; hosted mode
  hides the bug switch; another browser session gets 404 for the first one's chat and keeps its own data.
- **The draft platform entry**: [`docs/fieldkit/wealth-management.yaml`](fieldkit/wealth-management.yaml).

Still to do: test against Temporal Cloud with an API key (what the platform injects), validate the draft with the
platform's `validate-projects`, and get it onto the platform's test cluster.

This plan follows the platform's contract (`docs/crd-reference.md` and `docs/platform-onboarding.md` in the
platform repo) and what the Google ADK repo's onboarding did (`temporal-sa/adk-wealth-management`, commit `7e0bb00`,
PR #11, deployed as `projects/live/demo/adk-wealth-management.yaml`).

## What the platform does and expects

A demo is a `DemoProject` file in the platform repo (`projects/test/demo/` and `projects/live/demo/`). Flux applies it
once it is on `main`, and the platform's operator then:

- builds an image per `builds` entry, from Dockerfiles in our repo, with CodeBuild (linux/amd64; Docker build
  arguments aren't supported, so each image needs its own Dockerfile);
- runs each `components` entry as a container: image, command and environment. `worker: true` marks a Temporal
  worker, `temporalAccess: true` a component that starts or queries workflows (the API);
- gives the demo a Temporal Cloud namespace, injecting `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`,
  `TEMPORAL_API_KEY` and `TEMPORAL_TLS=true` into those components;
- runs a Redis for the demo (`spec.redis`), injecting `REDIS_URL`, `REDIS_PASSWORD`, `REDIS_HOST` and `REDIS_PORT`;
- passes the platform's model keys through shared secrets (`openai`, `gemini`, `anthropic`). With
  `llm.gateway: direct` the components get the raw keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
  `ANTHROPIC_API_KEY`); with `litellm` they get a LiteLLM virtual key plus base-URL variables, which every SDK
  would have to follow;
- serves the demo on a subdomain behind Temporal sign-in (`ingress.temporalAuthRequired`), routing paths to
  components;
- checks a smoke path (`smokeCheck`) after each rollout.

Components must be stateless, long-running processes configured through the environment.

## What already fits

- Every language reads the injected Temporal settings: Python, TypeScript and Go through Temporal's environment
  configuration, Java (Spring AI) and .NET from `TEMPORAL_API_KEY` with TLS.
- Redis: `REDIS_URL` with a password is read everywhere.
- Shared use: server-issued browser sessions, chat IDs chosen by the API, chaos switches and demo data per session
  in Redis (`DEMO_DATA_STORE=redis`), the **Approve compliance review** button, and the one-hour idle timeout for
  chats.
- Model keys and models come from environment variables.

## Target shape

One `DemoProject` for the whole repository: one web component (the API serving the built web app) and one worker per
framework, all in the demo's one Cloud namespace, each on its own task queue (`<short name>-Supervisor`, model calls on
`<queue>-llm`). The sidebar lists all 12.

Frameworks: `openai_agents`, `pyai`, `strands_agents`, `google_adk`, `pure`, `langgraph_agents` (Python);
`vercel_ai`, `google_adk_ts`, `strands_agents_ts`, `openai_agents_ts` (TypeScript); `google_adk_go` (Go); `spring_ai`
(Java). Not in phase 1: the experimental `agent_framework_dotnet`, and the Java open-account worker (every framework
runs its own open-account workflow).

Sketch (names and resources to be settled while testing):

```yaml
apiVersion: registry.tmprl-demo.cloud/v1alpha1
kind: DemoProject
metadata:
  name: wealth-management
  annotations:
    registry.tmprl-demo.cloud/operator: v2
spec:
  registry:
    title: "Wealth Management Agents: twelve agent frameworks"
    summary: The same multi-agent banking chat built with twelve agent frameworks in Python, TypeScript, Go and
      Java, each a durable Temporal workflow ...
    temporalSdks: [Python, TypeScript, Go, Java]
    aiSdks: [OpenAI Agents SDK, Pydantic AI, Strands Agents, Google ADK, LangGraph, Vercel AI SDK, Spring AI]
  source:
    repo: https://github.com/temporal-sa/wealth-management-demo
    branch: main
  llm:
    gateway: direct
  builds:
    web:                { context: ., dockerfile: docker/web.Dockerfile }
    openai-agents:      { context: ., dockerfile: docker/python-openai-agents.Dockerfile }
    pyai:               { context: ., dockerfile: docker/python-pyai.Dockerfile }
    strands-agents:     { context: ., dockerfile: docker/python-strands-agents.Dockerfile }
    google-adk:         { context: ., dockerfile: docker/python-google-adk.Dockerfile }
    pure:               { context: ., dockerfile: docker/python-pure.Dockerfile }
    langgraph:          { context: ., dockerfile: docker/python-langgraph.Dockerfile }
    typescript:         { context: ., dockerfile: docker/typescript.Dockerfile }
    go:                 { context: ., dockerfile: docker/go.Dockerfile }
    spring-ai:          { context: ., dockerfile: docker/spring-ai.Dockerfile }
  secrets:
    openai:    { shared: openai,    requiredProperties: [OPENAI_API_KEY] }
    gemini:    { shared: gemini,    requiredProperties: [GEMINI_API_KEY] }
    anthropic: { shared: anthropic, requiredProperties: [ANTHROPIC_API_KEY] }
  components:
    web:
      build: web
      temporalAccess: true
      ports: [{ name: http, containerPort: 8000, servicePort: 80 }]
      env:
        - { name: AI_FRAMEWORK, value: "openai_agents,pyai,...,spring_ai" }
        - { name: DEMO_HOSTED, value: "true" }
    worker-openai-agents:
      build: openai-agents
      worker: true
      secrets: [openai]
      env: [{ name: DEMO_DATA_STORE, value: redis }]
    worker-vercel-ai:
      build: typescript
      command: ["npm", "run", "--workspace", "vercel_ai", "temporal:worker"]
      worker: true
      secrets: [gemini]
      env: [{ name: DEMO_DATA_STORE, value: redis }]
    # ... one worker component per framework
  ingress:
    subdomain: wealth
    temporalAuthRequired: true
  smokeCheck:
    path: /api/health
    expectedStatus: 200
  redis:
    version: '7'
```

Workers keep the default of one replica: the web app checks for each framework's workers (`GET /api/config`) before
any chat starts, which a worker scaled to zero would fail.

## Work in this repository

### 1. The API

- **Serve the built web app at `/`** when it is present (`frontend/build`), with `/api/*` going to the API as now,
  so one container is the whole website. Locally, the React dev server keeps proxying `/api`.
- **`GET /api/health`**: answers 200 when Redis responds (it doesn't check the workers, which `/api/config`
  reports per framework).
- **Hosted mode** (`DEMO_HOSTED=true`): leave the "Bug in workflow code" switch out of the chaos panel, and refuse to
  set it, because visitors can't edit the workflow and restart its worker to finish that scenario. A self-healing
  switch is phase 2.
- Check the session cookie and proxy headers behind the platform's ingress (Secure over HTTPS).

### 2. Container images (`docker/`)

All built from the repository root (each needs `data/` and its language's `common`), running as a non-root user,
configured only through the environment, with `DATA_DIR` pointing at the copied `data/` (read-only seed; demo data
lives in Redis per session).

| Image | Holds | Command |
| --- | --- | --- |
| `web` | A Node stage builds `frontend/`; a Python 3.13 stage runs the API with `uv`, serving the build | `uvicorn api.main:app --host 0.0.0.0 --port 8000 --proxy-headers` |
| `python-<framework>` (6) | The framework's locked environment (`uv sync --frozen`) with its Python version (3.13 or 3.14) and `src/python/common` | That framework's worker (`python run_worker.py` or `python -m durable.run_worker`) |
| `typescript` | The npm workspace (`src/typescript`), compiled or with `ts-node` | One command per framework (`npm run --workspace <framework> temporal:worker`) |
| `go` | The Go worker binary | `/worker` |
| `spring-ai` | The Spring AI worker's built jar on a JRE 25 | `java -jar ...` |

A root `.dockerignore` keeps out keys (`scripts/set*.sh`, `.env`, `*.pem`, `*.key`), virtual environments,
`node_modules`, build output and `logs/`.

### 3. Each worker from the environment alone

Check that every worker starts with no `scripts/set*.sh` sourced: model keys and models from the environment (Pure
Python's `LLM_MODEL` defaulting to an Anthropic model with `ANTHROPIC_API_KEY`), no files outside the image, a clean
shutdown on SIGTERM, and logs on stdout.

### 4. Local Compose with the same shape

`docker-compose.yml`: a Temporal dev server (7233, UI 8233), Redis with a password, the web component on 8000 and the
12 workers, with a Compose profile per framework so a run can start a few. Keys come from a gitignored `.env`. This
is how the images are tested before the platform builds them, and the local route the platform recommends keeping
("Local to Cloud shape"). The platform's own CLI (`fieldkit up`, `docs/local-cli.md` in the platform repo) can then
run the `DemoProject` itself locally, if we have access to it.

### 5. Docs

- Root README: running the demo in containers, and the hosted demo (link, sign-in, what's shared per browser session,
  what's left out).
- `docs/hosting-plan.md` (this file) replaced by the hosting notes once done.

### 6. Testing

- Build every image; run each worker container against the dev server and check its task queues have pollers.
- With Compose: the web app's sidebar shows all 12 frameworks with workers; a chat in each answers; an account opening
  through KYC, the approve button and Complete in a few; two browser sessions don't see each other's chats, data or
  chaos switches; the bug switch is absent in hosted mode; `/api/health` answers.
- Against Temporal Cloud with an API key (what the platform injects), which hasn't been tested with every language.

## Work on the platform

1. Draft the `DemoProject` for the **test** cluster (`projects/test/demo/wealth-management.yaml`) and validate it
   (`go run ./cmd/validate-projects` in the platform repo's `operator/`).
2. Get it in: a pull request to the platform repo, or the catalog's **Add a Demo** page (whose onboarding agent drafted
   the Google ADK change). Someone with approval on the platform repo signs it off.
3. Check the test deployment: builds, rollout, smoke check, chats in every framework from two browsers.
4. Then live (`projects/live/demo/`), and decide what happens to the separate Google ADK demo
   (`adk-wealth-management`), which this one would include.

## Phase 2 (not in this plan)

- **Claim check**: an S3 claim-check store (`CLAIM_CHECK_S3_BUCKET`, from `spec.aws.s3`) in every codec (Python,
  TypeScript, Go, Java, .NET); a codec endpoint in the API (`/codec`, a public route, with Temporal Cloud sign-in
  checks) so the Cloud UI can decode payloads; then `USE_CLAIM_CHECK=true` on the hosted copy. Redis isn't suitable:
  the platform's Redis is a plain container, and claim-checked payloads must outlive it for workflows to replay.
- **"Bug in workflow code" that heals itself** when the switch is turned off, in every open-account workflow, so the
  scenario works hosted.
- **The LiteLLM gateway** (`llm.gateway: litellm`), once every framework's model client follows the base-URL
  variables.
- **Crashable workspaces**, letting visitors kill workers.
- **The experimental .NET framework** and the Java open-account worker.

## Open questions

- Who approves `DemoProject` changes on the platform repo, and should this go through **Add a Demo** or a direct pull
  request?
- Resources: 13 components (12 workers at roughly 200m CPU and 384 to 1024 MiB each). Is that within what a demo may
  use?
- Build time and image size: the Python frameworks' dependencies are large. CodeBuild's default machine (`medium`)
  may need `compute: large` for some builds.
- Model spend: a shared hosted demo on the platform's keys, with `gemini-3.8-flash`, `gpt-4o` and, for Pure Python,
  `anthropic/claude-opus-5-5` by default (`LLM_MODEL`). The hosted copy could set a cheaper `LLM_MODEL` for it.
- The Google ADK demo: keep it alongside this one, or retire it once this one is live.
