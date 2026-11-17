# Shared scripts

Settings files that every port's start scripts source, plus scripts that work with any language. Create the `.sh` files from the `.example` files here; only the `.example` files are committed.

| File | Purpose |
|---|---|
| `setoaikey.example` → `setoaikey.sh` | OpenAI API key (`OPENAI_API_KEY`): OpenAI Agents and Pydantic AI ports |
| `setgeminikey.example` → `setgeminikey.sh` | Gemini API key (`GEMINI_API_KEY`): Strands Agents port |
| `setclaimcheck.example` → `setclaimcheck.sh` | Optional claim check: `USE_CLAIM_CHECK`, Redis host and port |
| `setcloudenv.example` → `setcloudenv.sh` | Temporal Cloud address, namespace and mTLS cert and key |
| `setsplitworkflows.sh` | Sourced by worker scripts: a queue argument moves the open-account workflow onto that queue (e.g. for the Java worker) |

Other ports add their key files here too, so ports that use the same provider share one key file.
