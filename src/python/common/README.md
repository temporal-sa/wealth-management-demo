# Python common

Code shared by every Python port and the [API](../api/README.md). None of it imports an agent framework.

| Module | Holds |
|---|---|
| `beneficiaries_manager.py`, `client_manager.py`, `funding_manager.py`, `investment_manager.py` | Read and write the demo data in the root `data/` folder |
| `account_context.py`, `user_message.py`, `status_update.py` | Types in the Temporal contracts (`ProcessUserMessageInput`, `UpdateAccountOpeningStateInput`, chat and status events) |
| `event_stream_manager.py` | The Redis event stream the front end polls |
| `chaos_manager.py` | The chaos panel's flags and failure log, in Redis |
| `client_helper.py`, `redis_config.py`, `util.py` | Temporal and Redis connection settings from the environment |
| `claim_check/` | The claim-check payload codec and client plugin (`USE_CLAIM_CHECK`) |

Port-specific code stays in the port: the reference port's prompts, which import the OpenAI Agents SDK, are in `src/python/openai_agents/prompts/`.

Ports import this code as `common.*`. Each port's `pyproject.toml` puts `src/python` on the path with hatch's `dev-mode-dirs = [".", ".."]`, so these modules import with no install step.
