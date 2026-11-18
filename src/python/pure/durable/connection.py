"""How this port's worker and scripts connect to Temporal.

The connection settings come from the shared ClientHelper (src/python/common), with this
port's default task queue. Payloads use Temporal's Pydantic data converter, like the shared
API (src/python/api), so both sides read each other's signals and results. With
USE_CLAIM_CHECK on, the shared claim check codec (common.claim_check) stores every payload in
Redis; the Java worker uses the same format.
"""

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter

from common.claim_check.claim_check_plugin import ClaimCheckPlugin, use_claim_check
from common.client_helper import ClientHelper
from common.redis_config import RedisConfig
from durable.task_queues import DEFAULT_TASK_QUEUE


def client_helper() -> ClientHelper:
    """Connection settings and task queues, defaulting to this port's task queue."""
    return ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE)


async def connect(helper: ClientHelper) -> Client:
    return await Client.connect(**helper.client_config, data_converter=pydantic_data_converter,
                                plugins=[ClaimCheckPlugin()])


def claim_check_status() -> str:
    """For startup messages: whether claim check is on, and which Redis it uses."""
    if not use_claim_check():
        return "Claim check: off"
    redis = RedisConfig()
    return f"Claim check: ON (payloads stored in Redis at {redis.hostname}:{redis.port})"
