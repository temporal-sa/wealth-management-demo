"""The model call the agent nodes make in the Temporal version.

Each agent node runs as an activity (Temporal's LangGraph plugin, on <TEMPORAL_TASK_QUEUE>-llm with
LLM_RETRY_POLICY), so this runs inside it. LangChain's own retries are off, so Temporal alone
decides when a failed call is retried:

* an outage (connection error, 5xx) is retried with the policy's backoff;
* a 429 sets the activity's next retry delay (15 s), which overrides the backoff.

The chaos panel's "model API down" and "rate limited" switches inject those same two failures
here, before Gemini is called.
"""

from datetime import timedelta

from langchain_core.messages import AIMessage, AnyMessage
from temporalio import activity
from temporalio.exceptions import ApplicationError

from common.chaos_manager import ChaosFlag
from durable.chaos import inject_failure
from lg_agents import llm

PROVIDER = "Gemini"
# Used for a 429, and by the chaos panel's rate-limit switch.
RATE_LIMIT_RETRY_AFTER = timedelta(seconds=15)


def rate_limited(message: str) -> ApplicationError:
    return ApplicationError(message, type="ModelRateLimited", next_retry_delay=RATE_LIMIT_RETRY_AFTER)


def _is_rate_limit(error: Exception) -> bool:
    return getattr(error, "code", None) == 429 or "RESOURCE_EXHAUSTED" in str(error) or "429" in str(error)


async def invoke_model(system: str, messages: list[AnyMessage], tools: list[dict]) -> AIMessage:
    await inject_failure(ChaosFlag.LLM_DOWN, ConnectionError(f"{PROVIDER} API unavailable"))
    await inject_failure(ChaosFlag.LLM_RATE_LIMITED, rate_limited(f"{PROVIDER} API rate limit exceeded (HTTP 429)"))
    try:
        return await llm.complete(system, messages, tools, max_retries=0)
    except Exception as e:
        if _is_rate_limit(e):
            raise rate_limited(f"{PROVIDER} API rate limit exceeded (HTTP 429): {e}") from e
        # Anything else is retried too. A wrong key or model name won't fix itself, but the worker
        # can be restarted with the right settings, and the turn carries on.
        activity.logger.warning(f"Model call failed: {e}")
        raise
