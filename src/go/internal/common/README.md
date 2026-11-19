# Go common

Go packages shared by the Go frameworks, with no agent framework:

| Package | Holds |
|---|---|
| `chaos` | The chaos panel's failure-injection flags, read from Redis per browser session |
| `claimcheck` | The claim-check payload codec (the same format as the Python, TypeScript and Java codecs) |
| `data` | The data store for the shared `data/*.json` files (or, with `DEMO_DATA_STORE=redis`, each session's copy in Redis) |
| `domain` | The payloads of the shared Temporal contract |
| `eventstream` | The Redis event stream the web UI reads through the API |
| `redisx` | Redis connection settings |
| `session` | Browser sessions: the session in a workflow ID, and the current activity's session |
| `testfixtures` | The test copy of the demo data |

They are part of the one Go module, `src/go/go.mod`. The prompts, agents and client settings are per framework
(for example `google_adk/internal/prompts` and `google_adk/internal/config`).
