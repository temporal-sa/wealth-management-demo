"""Calls the model through LiteLLM, the only model dependency.

LiteLLM gives Anthropic, OpenAI and Gemini one API in the OpenAI chat format, so the
provider is chosen by the model name (LLM_MODEL), not by the code.

Never imported by workflow code: in the Temporal version this runs inside the
invoke_model activity.
"""

import litellm

from common.agent_loop import ModelRequest, ModelResponse, ToolCall
from common.llm_config import llm_model

# Don't send LiteLLM's anonymous usage telemetry.
litellm.telemetry = False
# Drop request parameters a provider doesn't support instead of failing.
litellm.drop_params = True


async def complete(request: ModelRequest, num_retries: int = 0) -> ModelResponse:
    """Call the model once.

    ``num_retries`` is LiteLLM's own retrying of failed calls. The Temporal version
    leaves it at 0, so that Temporal's retry policy alone decides when to retry.
    """
    response = await litellm.acompletion(
        model=request.model or llm_model(),
        messages=[{"role": "system", "content": request.system}, *request.messages],
        tools=request.tools or None,
        num_retries=num_retries,
        max_retries=num_retries,
    )
    message = response.choices[0].message
    tool_calls = [ToolCall(id=c.id, name=c.function.name, arguments=c.function.arguments or "{}")
                  for c in (message.tool_calls or [])]
    content = message.content or None
    if content is None and not tool_calls:
        # Providers reject an empty assistant message later in the conversation.
        content = "Sorry, I don't have a response to that. Could you rephrase it?"
    return ModelResponse(content=content, tool_calls=tool_calls)
