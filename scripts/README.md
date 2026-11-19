# Shared scripts

Settings files that every framework's start scripts source, plus scripts that work with any language. Create the `.sh` files from the `.example` files here; only the `.example` files are committed.

| File | Purpose |
|---|---|
| `setoaikey.example` → `setoaikey.sh` | OpenAI API key (`OPENAI_API_KEY`): OpenAI Agents and Pydantic AI frameworks |
| `setgeminikey.example` → `setgeminikey.sh` | Gemini API key (`GEMINI_API_KEY`): Strands Agents, Google ADK (Python, TypeScript and Go) and Vercel AI SDK frameworks. All of them also read an optional `GEMINI_MODEL` (default `gemini-3.8-flash`) |
| `setllmkey.example` → `setllmkey.sh` | Pure Python framework: `LLM_MODEL` (a LiteLLM `<provider>/<model>` name) and that provider's key (Anthropic by default; OpenAI or Gemini also work) |
| `setclaimcheck.example` → `setclaimcheck.sh` | Optional claim check: `USE_CLAIM_CHECK`, and where Redis is: host and port, an optional `REDIS_PASSWORD`, or a `REDIS_URL` that wins over them |
| `setcloudenv.example` → `setcloudenv.sh` | Temporal Cloud address, namespace, and either an mTLS cert and key or an API key |
| `setsplitworkflows.sh` | Sourced by worker scripts: a queue argument moves the open-account workflow onto that queue (e.g. for the Java worker) |

Other frameworks add their key files here too, so frameworks that use the same provider share one key file.
