"""Which model each framework's worker uses, for the web UI's sidebar.

Each worker records its model in Redis at startup, under its chat task queue, which the API already knows for every
framework (api/frameworks.py), so the sidebar can show the model the running worker actually uses: the value of
GEMINI_MODEL, OPENAI_MODEL or LLM_MODEL, or the framework's default. The workers in the other languages write the
same hash (key WORKER_INFO_KEY, field the chat task queue, value JSON {"model": ...}).

A restarted worker overwrites its entry. Nothing expires: the API shows the model only for a framework whose worker
is polling, so an entry left by a stopped worker isn't shown.
"""
import json
from typing import Dict, Iterable, Optional

from common.redis_config import RedisConfig

WORKER_INFO_KEY = "worker-info"


async def publish_worker_model(task_queue: str, model: str, config: Optional[RedisConfig] = None) -> None:
    """Record this worker's model. A Redis failure is reported and ignored: the worker runs without it."""
    client = (config or RedisConfig()).async_client()
    try:
        await client.hset(WORKER_INFO_KEY, task_queue, json.dumps({"model": model}))
    except Exception as e:  # noqa: BLE001 - the model display is optional
        print(f"Couldn't record the model in Redis, so the web UI won't show it: {e}")
    finally:
        await client.aclose()


async def worker_models(task_queues: Iterable[str], config: Optional[RedisConfig] = None) -> Dict[str, str]:
    """The model each of these chat task queues' workers recorded, by task queue (missing if none recorded one)."""
    queues = list(task_queues)
    if not queues:
        return {}
    client = (config or RedisConfig()).async_client()
    try:
        values = await client.hmget(WORKER_INFO_KEY, queues)
    finally:
        await client.aclose()
    models = {}
    for queue, value in zip(queues, values):
        try:
            model = json.loads(value).get("model") if value else None
        except (ValueError, AttributeError):
            model = None
        if model:
            models[queue] = model
    return models
