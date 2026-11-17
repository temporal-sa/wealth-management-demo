# Python common

For code shared by every Python port: data managers, Redis event stream, chaos flags, claim-check codec, client config.

Empty for now. Each port's `common/` stays in its own folder until a second port is imported and the identical parts can be moved here. The reference copy, `src/python/openai_agents/common`, includes prompts that import the OpenAI Agents SDK, so it can't be shared as-is.
