# Hosting on the Temporal FieldKit platform

The demo runs as one hosted, shared demo on the Temporal FieldKit platform (`temporal-sa/temporal-fieldkit-platform`):
the 12 stable frameworks in one web app, on Temporal Cloud, behind Temporal sign-in. Phase 1 (below) is done; phase 2
is still to do.

## Status

**Phase 1 is live**, on the `wealth` subdomain of both clusters:

| Cluster | URL | Platform file |
| --- | --- | --- |
| test | https://wealth.test.tmprl-demo.cloud | `projects/test/demo/wealth-management.yaml` (temporal-sa/temporal-fieldkit-platform#183) |
| live | https://wealth.tmprl-demo.cloud | `projects/live/demo/wealth-management.yaml` (temporal-sa/temporal-fieldkit-platform#190) |

All 12 frameworks run there, checked through every framework: chats, account openings through KYC and approval, the
chaos switches, and the model and build display.

**How a change reaches them.** Both copies build from this repository's `main`. The platform resolves `main` to a
commit on each reconcile, so a merge here rebuilds the images and rolls the workers on test and on live, with no
platform change. The build label at the bottom of the sidebar (`DEMO_BUILD`, the platform's rollout version) starts
with the commit each copy runs: `git-<commit>-i<hash>`.

**How the DemoProject changes.** The deployed files are in the platform repo, and a change goes there as a pull
request, test first. Merging one to `projects/live/demo/` is a live deploy within minutes, and it's the platform
owner's call. The platform's `check-live-projects.sh` checks a live file against the newest release tag's operator.
[`docs/fieldkit/wealth-management.yaml`](fieldkit/wealth-management.yaml) is this repository's copy of the same
file: keep it identical to the platform's, and validate changes there (`go run ./cmd/validate-projects` in the
platform repo's `operator/`).

## What phase 1 added

In this repository:

- **The images**: ten Dockerfiles in `docker/` (web, six Python workers, one TypeScript image for four workers, Go,
  Spring AI) and a root `.dockerignore`. Every container is configured through the environment alone.
- **The API** serves the built web app at `/` (`WEB_APP_DIR`) and answers `GET /api/health` (the platform's smoke
  check). With `DEMO_HOSTED=true` it leaves out the "Bug in workflow code" switch, which a visitor couldn't finish,
  and the chaos panel shows only the demo scenarios whose switches the API offers.
- **What's running**: every worker records its model in Redis at startup, and the sidebar shows it under each
  framework, with the build at the bottom.
- **`docker-compose.yml`** in the hosted shape, with a profile per framework, and
  [`docker-compose.cloud.yml`](../docker-compose.cloud.yml) to run the same containers on Temporal Cloud with an API
  key, as the platform connects.

Problems found along the way, each fixed:

| Found | Problem | Fix |
| --- | --- | --- |
| Cloud, mTLS | The TypeScript image had no CA certificates, so no TLS connection worked | Install `ca-certificates` |
| Cloud, API key | The Strands Agents (Python) worker built its own connection that only knew mTLS | Use Temporal's environment configuration, like the other workers |
| Test cluster | Three TypeScript workers ran out of Node heap at startup under the 1Gi limit (ts-node type-checking) | `TS_NODE_TRANSPILE_ONLY=true` in the image |
| Test cluster | Pure Python ran on its default, `anthropic/claude-opus-5-5`, on the platform's shared key | `LLM_MODEL=anthropic/claude-haiku-5-5` (compared below) |
| Test cluster | The chaos panel described the bug scenario that hosted mode leaves out | Show only scenarios whose switches the API offers |
| Test cluster | On Haiku, a Pure Python agent "corrected" another agent's earlier reply in the shared history | A line in Pure's handoff prompt |
| Test cluster | On Haiku, Pure Python's lists had no bold names: its prompts had no formatting rules | The same Formatting section as LangGraph and .NET |
| Test cluster | A message that failed to send said only "Failed to get response from bot" | Say it wasn't delivered and keep it in the message field |

Pure Python's model was chosen by running its scenarios (list, off-topic, add and delete a beneficiary with
confirmation, close an account, open one through KYC and approval, an LLM outage), two trials each, on Claude Haiku
5.5, Sonnet 5.5, Gemini 3.5 Flash and Opus 5.5. All passed every check, and Haiku was the fastest. The other
frameworks run on `gemini-3.8-flash` or `gpt-4o`.

An API key needs Temporal Cloud's regional endpoint (`<region>.<cloud>.api.temporal.io:7233`) only when the namespace
allows both mTLS and API keys; a namespace that uses API keys only works on its own endpoint. The platform injects
its own address.

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
  `llm.gateway: direct` the components get the raw keys; with `litellm` they get a LiteLLM virtual key plus base-URL
  variables, which every SDK would have to follow;
- serves the demo on a subdomain behind Temporal sign-in (`ingress.temporalAuthRequired`), routing paths to
  components;
- checks a smoke path (`smokeCheck`) after each rollout.

Components must be stateless, long-running processes configured through the environment. Workers keep one replica:
the web app checks for each framework's workers (`GET /api/config`) before a chat starts, which a worker scaled to
zero would fail. Each worker is limited to its `resources` (the TypeScript workers to 1Gi), which Compose doesn't
enforce, so test a memory change with a Compose memory limit.

## The hosted shape

One `DemoProject` for the whole repository (the file above): a `web` component, which is the API serving the built
web app, and one worker per framework, all in the demo's one Cloud namespace, each on its own task queue
(`<short name>-Supervisor`, model calls on `<queue>-llm`). Each browser session gets its own chats, demo data and
chaos switches in Redis (`DEMO_DATA_STORE=redis`).

Frameworks: `openai_agents`, `pyai`, `strands_agents`, `google_adk`, `pure`, `langgraph_agents` (Python);
`vercel_ai`, `google_adk_ts`, `strands_agents_ts`, `openai_agents_ts` (TypeScript); `google_adk_go` (Go); `spring_ai`
(Java). Not hosted yet: the experimental `agent_framework_dotnet`, and the Java open-account worker (every framework
runs its own open-account workflow).

## Phase 2

- **Claim check**: an S3 claim-check store (`CLAIM_CHECK_S3_BUCKET`, from `spec.aws.s3`) in every codec (Python,
  TypeScript, Go, Java, .NET); a codec endpoint in the API (`/codec`, a public route, with Temporal Cloud sign-in
  checks) so the Cloud UI can decode payloads; then `USE_CLAIM_CHECK=true` on the hosted copy. Redis isn't suitable:
  the platform's Redis is a plain container, and claim-checked payloads must outlive it for workflows to replay.
- **"Bug in workflow code" that heals itself** when the switch is turned off, in every open-account workflow, so the
  scenario works hosted.
- **The LiteLLM gateway** (`llm.gateway: litellm`), once every framework's model client follows the base-URL
  variables.
- **Crashable workspaces**, letting visitors kill workers. The "Slow account-opening steps" switch's description
  still suggests killing a worker mid-way, which visitors can't do until then.
- **The experimental .NET framework** and the Java open-account worker.

## Open questions

- The separate Google ADK demo (`adk-wealth-management`, subdomain `wealth-adk`): keep it alongside this one, or
  retire it now that this one, which includes Google ADK in Python, TypeScript and Go, is live.
