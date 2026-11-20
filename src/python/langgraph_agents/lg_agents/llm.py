"""Calls Gemini through LangChain (langchain-google-genai), as every agent node does.

GEMINI_MODEL picks the model (scripts/setgeminikey.sh can set it; the default is the shared
common.gemini_model's), and GEMINI_API_KEY (or GOOGLE_API_KEY) is the key.

Never imported by workflow code: in the Temporal version this runs inside the agent nodes'
activities.
"""

import os

from langchain_core.messages import AIMessage, AnyMessage, SystemMessage

from common.gemini_model import gemini_model

EMPTY_REPLY = "Sorry, I don't have a response to that. Could you rephrase it?"


def api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set. Copy scripts/setgeminikey.example to "
                           "scripts/setgeminikey.sh, set your key, and source it.")
    return key


async def complete(system: str, messages: list[AnyMessage], tools: list[dict], max_retries: int = 0) -> AIMessage:
    """Call the model once.

    ``max_retries`` is LangChain's own retrying of failed calls. The Temporal version leaves it at
    0, so that Temporal's retry policy alone decides when to retry.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI

    model = ChatGoogleGenerativeAI(model=gemini_model(), api_key=api_key(), max_retries=max_retries)
    reply = await (model.bind_tools(tools) if tools else model).ainvoke([SystemMessage(system), *messages])
    if not reply.text and not reply.tool_calls:
        # Providers reject an empty assistant message later in the conversation.
        return AIMessage(EMPTY_REPLY, id=reply.id)
    return reply
