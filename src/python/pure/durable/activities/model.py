"""The model call, as an activity: every LLM call the agents make is durable.

The chat workflow runs ``invoke_model`` on its own task queue (<TEMPORAL_TASK_QUEUE>-llm)
with LLM_RETRY_POLICY. LiteLLM's own retries are off, so Temporal alone decides when a
failed call is retried:

* an outage (connection error, 5xx) is retried with the policy's backoff;
* a 429 sets the activity's next retry delay from the provider's Retry-After header
  (15 s if it has none), which overrides the backoff.

The chaos panel's "model API down" and "rate limited" switches inject those same two
failures here, before the provider is called.
"""

from datetime import timedelta
from typing import Optional

from temporalio import activity
from temporalio.exceptions import ApplicationError

from common.agent_loop import ModelRequest, ModelResponse
from common.chaos_manager import ChaosFlag
from common.llm_config import provider_name
from temporal_supervisor.chaos import inject_failure

# Used when a 429 has no Retry-After header, and by the chaos panel's rate-limit switch.
RATE_LIMIT_RETRY_AFTER = timedelta(seconds=15)


def rate_limited(message: str, retry_after: timedelta = RATE_LIMIT_RETRY_AFTER) -> ApplicationError:
    return ApplicationError(message, type="ModelRateLimited", next_retry_delay=retry_after)


def _retry_after(error: Exception) -> Optional[timedelta]:
    """The Retry-After delay of a provider's 429 response, if it sent one."""
    for headers in (getattr(error, "headers", None),
                    getattr(error, "litellm_response_headers", None),
                    getattr(getattr(error, "response", None), "headers", None)):
        value = next((v for k, v in dict(headers or {}).items() if k.lower() == "retry-after"), None)
        if value is not None:
            break
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return timedelta(seconds=seconds) if seconds > 0 else None


@activity.defn
async def invoke_model(request: ModelRequest) -> ModelResponse:
    provider = provider_name()
    await inject_failure(ChaosFlag.LLM_DOWN, ConnectionError(f"{provider} API unavailable"))
    await inject_failure(ChaosFlag.LLM_RATE_LIMITED, rate_limited(f"{provider} API rate limit exceeded (HTTP 429)"))

    # Imported here so that importing this module (as the tests and the workflow's
    # activity references do) doesn't load LiteLLM.
    import litellm
    from common.llm import complete

    try:
        return await complete(request, num_retries=0)
    except litellm.RateLimitError as e:
        raise rate_limited(f"{provider} API rate limit exceeded (HTTP 429): {e}",
                           _retry_after(e) or RATE_LIMIT_RETRY_AFTER) from e
    except (litellm.AuthenticationError, litellm.BadRequestError, litellm.NotFoundError) as e:
        # A wrong key, model name or request won't fix itself, but the worker can be
        # restarted with the right settings, so the call is still retried (Temporal
        # keeps the turn waiting). The message says what to fix.
        activity.logger.error(f"Model call failed and needs a configuration fix: {e}")
        raise
