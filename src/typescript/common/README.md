# TypeScript common

Shared by the TypeScript frameworks (Vercel AI SDK and Google ADK), with no agent framework: the shared
Temporal contract (`shared.ts`: signal names and payloads), the data managers for `data/*.json`, the Redis event
stream, the chaos flags, the claim-check codec and the Temporal client settings (`ClientHelper`, which takes the
framework's default task queue). The prompts are per framework (`<framework>/prompts`).

It is an npm workspace (see `src/typescript/package.json`); frameworks import it by relative path, and its
dependencies are installed in the shared `src/typescript/node_modules`.
