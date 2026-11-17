# Pure Python (hand-written loop, LiteLLM)

From [temporal-sa/pure-wealth-management](https://github.com/temporal-sa/pure-wealth-management).

Holds that repo's `src/` and `tests/` (and its dependency file), with its standalone `*_supervisor/` folder renamed to `standalone/` and `temporal_supervisor/` renamed to `durable/`, as in `src/python/openai_agents`. Its own dependency file keeps framework versions from conflicting with other ports. It uses the shared `../common` and `../api` (the API works with every port, so the port has no API of its own); only framework-specific code, such as `prompts/`, stays in the port.
