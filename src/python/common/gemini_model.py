"""The Gemini model the agents use, for the frameworks that call Gemini.

GEMINI_MODEL picks it (scripts/setgeminikey.sh can set it); the default is DEFAULT_GEMINI_MODEL,
the same as the TypeScript and Go frameworks. Workflow code must not read the environment, so
workflows get the model through a module imported with workflow.unsafe.imports_passed_through().
"""
import os

DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"


def gemini_model() -> str:
    return os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL
