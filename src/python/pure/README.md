# Pure Python (hand-written loop, LiteLLM)

From [temporal-sa/pure-wealth-management](https://github.com/temporal-sa/pure-wealth-management).

Holds that repo's `src/` and `tests/` (and its dependency file), with its standalone `*_supervisor/` folder renamed to `standalone/` and `temporal_supervisor/` renamed to `durable/`, as in `src/python/openai_agents`. Its own dependency file keeps framework versions from conflicting with other ports. Code that turns out to be identical across ports moves up to `../common` and `../api`.
