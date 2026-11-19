# TypeScript common

Shared by the TypeScript ports (Vercel AI SDK and Google ADK), with no agent framework: the shared
Temporal contract (`shared.ts`: signal names and payloads), the data managers for `data/*.json`, the Redis event
stream, the chaos flags, the claim-check codec and the Temporal client settings (`ClientHelper`, which takes the
port's default task queue). The prompts are per port (`<framework>/prompts`).

It is an npm workspace (see `src/typescript/package.json`); ports import it by relative path, and its
dependencies are installed in the shared `src/typescript/node_modules`.
