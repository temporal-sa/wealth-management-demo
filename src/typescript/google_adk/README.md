# Google ADK (TypeScript)

From [temporal-sa/adk-ts-wealth-management](https://github.com/temporal-sa/adk-ts-wealth-management).

Holds that repo's `src/` and `tests/` (and its dependency file), with its standalone `*_supervisor/` folder renamed to `standalone/` and `temporal_supervisor/` renamed to `durable/`, as in `src/python/openai_agents`. Its own dependency file keeps framework versions from conflicting with other ports. Code that turns out to be identical across ports moves up to `../common` and `../api`.
