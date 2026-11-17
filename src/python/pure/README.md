# Pure Python (hand-written loop, LiteLLM)

From [temporal-sa/pure-wealth-management](https://github.com/temporal-sa/pure-wealth-management).

Holds that repo's `src/` and `tests/` (and its dependency file), keeping its own folder names, such as the standalone `*_supervisor/` and `temporal_supervisor/`. Its own dependency file keeps framework versions from conflicting with other ports. Code that turns out to be identical across ports moves up to `../common` and `../api`.
