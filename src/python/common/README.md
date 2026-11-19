# Python common

Code shared by every Python framework and the [API](../api/README.md). None of it imports an agent framework.

| Module | Holds |
|---|---|
| `beneficiaries_manager.py`, `client_manager.py`, `funding_manager.py`, `investment_manager.py` | Read and write the demo data in the root `data/` folder (plus `display_name` / `account_name` lookups for the Strands Agents framework's approval questions) |
| `account_context.py`, `user_message.py`, `status_update.py` | Types in the Temporal contracts (`ProcessUserMessageInput`, `UpdateAccountOpeningStateInput`, chat and status events) |
| `event_stream_manager.py` | The Redis event stream the front end polls |
| `chaos_manager.py` | The chaos panel's flags and failure log, in Redis |
| `client_helper.py`, `redis_config.py`, `util.py` | Temporal and Redis connection settings from the environment. A framework passes its own default task queue: `ClientHelper(default_task_queue=...)` |
| `claim_check/` | The claim-check payload codec and client plugin (`USE_CLAIM_CHECK`, or an explicit codec). The plugin only adds the codec to the client's data converter, keeping the rest (such as the StrandsPlugin's failure converter), and works with Temporal Python SDK 1.18 (OpenAI Agents framework) and 1.19+ (Pydantic AI and Strands Agents frameworks). The payload format matches the Java worker's codec |

Framework-specific code stays in that framework's folder: the OpenAI Agents SDK's prompts, which import the OpenAI Agents SDK, are in `src/python/openai_agents/prompts/`.

Frameworks import this code as `common.*`. Each framework's `pyproject.toml` puts `src/python` on the path with hatch's `dev-mode-dirs = [".", ".."]`, so these modules import with no install step.
