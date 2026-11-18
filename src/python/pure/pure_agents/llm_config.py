"""Which model the agents use.

LLM_MODEL is a LiteLLM model name, "<provider>/<model>", so switching between
Anthropic, OpenAI and Gemini is a configuration change, not a code change. Set the
provider's key as well (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY).
"""

import os

DEFAULT_LLM_MODEL = "anthropic/claude-opus-5-5"

# Display names for the chaos panel labels.
_PROVIDER_NAMES = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "gemini": "Gemini",
    "vertex_ai": "Gemini",
}


def llm_model() -> str:
    return os.getenv("LLM_MODEL", DEFAULT_LLM_MODEL)


def provider_name(model: str | None = None) -> str:
    """The model provider's display name, such as "Anthropic"."""
    provider = (model or llm_model()).split("/", 1)[0]
    return _PROVIDER_NAMES.get(provider, provider.capitalize() if "/" in (model or llm_model()) else "Model")
