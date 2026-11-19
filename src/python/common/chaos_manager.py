import json
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional


from common.redis_config import RedisConfig
from common.session_scope import SESSION_TTL_SECONDS, current_session


class ChaosFlag(str, Enum):
    TOOL_DOWN = "tool_down"
    LLM_DOWN = "llm_down"
    LLM_RATE_LIMITED = "llm_rate_limited"
    CUSTODIAN_REJECTS = "custodian_rejects"
    SLOW_SAGA = "slow_saga"
    WORKFLOW_BUG = "workflow_bug"


@dataclass(frozen=True)
class ChaosFlagInfo:
    flag: ChaosFlag
    label: str
    description: str


# Display metadata for the UI chaos panel, in the order it is shown.
CHAOS_FLAGS: List[ChaosFlagInfo] = [
    ChaosFlagInfo(
        ChaosFlag.TOOL_DOWN,
        "Core banking API down",
        "Investment and beneficiary tools raise a connection error. Temporal retries until you turn this off.",
    ),
    ChaosFlagInfo(
        ChaosFlag.LLM_DOWN,
        "LLM API down",
        "Every model call raises a connection error. The agent pauses mid-turn and resumes when you turn this off.",
    ),
    ChaosFlagInfo(
        ChaosFlag.LLM_RATE_LIMITED,
        "LLM rate limited (429)",
        "Every model call is throttled. Retries wait for the server's Retry-After delay instead of the normal backoff.",
    ),
    ChaosFlagInfo(
        ChaosFlag.CUSTODIAN_REJECTS,
        "Custodian rejects new accounts",
        "The last account-opening step fails non-retryably, so the saga rolls back the funds transfer and the account.",
    ),
    ChaosFlagInfo(
        ChaosFlag.SLOW_SAGA,
        "Slow account-opening steps",
        "Each account-opening step takes a few extra seconds, so you can watch the saga (or kill the worker mid-way).",
    ),
    ChaosFlagInfo(
        ChaosFlag.WORKFLOW_BUG,
        "Bug in workflow code",
        "New account openings get a welcome-bonus promo code, and the workflow's promo code path has a bug. "
        "It pauses after compliance approval until you fix the code and restart the worker. "
        "Turning this off does not unstick openings that already have the promo code.",
    ),
]

_MAX_EVENTS = 50


def flags_key(session_id: str) -> str:
    return f"chaos:{session_id}:flags"


def events_key(session_id: str) -> str:
    return f"chaos:{session_id}:events"


class ChaosManager:
    """Stores failure-injection flags, and a log of the failures they caused, in Redis.

    Flags are read at runtime by activities and the model wrapper, so a failure can
    be switched on and off from the UI without restarting the worker.

    Each browser session has its own flags and log (common/session_scope.py), expiring a day after
    their last change. The API passes the caller's session; in an activity, the session comes from
    the running workflow's ID, so a flag only affects the chats of the browser that turned it on.
    """

    def __init__(self, config: RedisConfig = None, session_id: Optional[str] = None):
        config = config or RedisConfig()
        self.redis_client = config.async_client()
        self._session_id = session_id

    def _session(self) -> str:
        return self._session_id or current_session()

    async def is_enabled(self, flag: ChaosFlag) -> bool:
        return await self.redis_client.hget(flags_key(self._session()), flag.value) == "1"

    async def set_enabled(self, flag: ChaosFlag, enabled: bool) -> None:
        key = flags_key(self._session())
        if enabled:
            await self.redis_client.hset(key, flag.value, "1")
            await self.redis_client.expire(key, SESSION_TTL_SECONDS)
        else:
            await self.redis_client.hdel(key, flag.value)

    async def get_flags(self) -> Dict[str, bool]:
        enabled = await self.redis_client.hgetall(flags_key(self._session()))
        return {info.flag.value: enabled.get(info.flag.value) == "1" for info in CHAOS_FLAGS}

    async def record_event(
        self, flag: ChaosFlag, source: str, attempt: Optional[int], workflow_id: Optional[str]
    ) -> None:
        event = {
            "timestamp": time.time(),
            "flag": flag.value,
            "source": source,
            "attempt": attempt,
            "workflow_id": workflow_id,
        }
        key = events_key(self._session())
        await self.redis_client.lpush(key, json.dumps(event))
        await self.redis_client.ltrim(key, 0, _MAX_EVENTS - 1)
        await self.redis_client.expire(key, SESSION_TTL_SECONDS)

    async def get_events(self, limit: int = 20) -> List[Dict[str, Any]]:
        return [json.loads(e) for e in await self.redis_client.lrange(events_key(self._session()), 0, limit - 1)]

    async def clear_events(self) -> None:
        await self.redis_client.delete(events_key(self._session()))

    async def close(self):
        await self.redis_client.aclose()
