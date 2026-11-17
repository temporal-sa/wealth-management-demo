# Wealth Management Agent Demo

A multi-agent banking chat that shows what Temporal adds to an agent framework, built with eight frameworks in three languages. Each port has a standalone version (the framework alone) and a Temporal version (every model and tool call durable).

## Layout

```
data/                 Demo data (system of record). Reset: git checkout data/
testdata/             Committed seed copy used by all tests
docs/                 Docs; images/ for README images
frontend/             The one shared React app
contracts/            (optional) Language-neutral Temporal names, prompt lines, chaos flags
interop/
  open_account/java/  Java OpenInvestmentAccountWorkflow, works with every port
scripts/              Scripts that work with any language (compliance approval, cloud env, claim check)
src/<language>/
  common/             Code shared by that language's ports
  api/                REST API for the front end (works with every framework)
  <framework>/        One port: its own src/ and tests/, keeping its folder names
                      (e.g. <x>_supervisor/ standalone, temporal_supervisor/ Temporal version)
```

## Ports

| Port | Language | Folder | Original repo |
|---|---|---|---|
| OpenAI Agents SDK (reference) | Python | `src/python/openai_agents` | temporal-sa/oai-temporal-wealth-management |
| Google ADK | Python | `src/python/google_adk` | temporal-sa/adk-wealth-management |
| Pydantic AI | Python | `src/python/pydantic_ai` | temporal-sa/pyai-wealth-management |
| Strands Agents | Python | `src/python/strands` | temporal-sa/strands-wealth-management |
| Pure Python (LiteLLM) | Python | `src/python/pure` | temporal-sa/pure-wealth-management |
| Vercel AI SDK | TypeScript | `src/typescript/vercel_ai` | temporal-sa/vai-wealth-management |
| Google ADK | TypeScript | `src/typescript/google_adk` | temporal-sa/adk-ts-wealth-management |
| Google ADK | Go | `src/go/google_adk` | temporal-sa/adk-go-wealth-management |

## Adding an integration

Create `src/<language>/<framework>/` with the standalone version, the Temporal version, tests and its own dependency file. Reuse that language's `common/` and `api/`, and match the Temporal contracts so the Java worker and shared scripts work unchanged.

## Open decisions before migrating code

- **Task queues:** every port defaults to `Supervisor`. Give each port its own default queue so two ports' workers can run at once.
- **Chat workflow ID prefix:** make it a runtime setting of `frontend/` instead of a per-port edit.
- **Python ADK port:** it has drifted from the PRD (own front end, own data, chaos flags per browser session). Decide whether to bring it back to the reference first.
- **History:** import each repo with `git filter-repo --to-subdirectory-filter` or `git subtree add` to keep its history.
