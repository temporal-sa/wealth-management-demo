"""Which AI framework the API serves: its task queue and the prefix of its chat workflow IDs.

Each framework is one version of the demo (src/python/<framework>, or src/typescript/<framework> or
src/go/<framework> for a TypeScript or Go one, whose chat workflows follow the same Temporal contract). AI_FRAMEWORK picks it.
It has no default: the start scripts require the framework as their argument (e.g.
./startlocalapi.sh google_adk) and, without a valid one, stop and list every framework.
TEMPORAL_TASK_QUEUE and CHAT_WORKFLOW_ID_PREFIX override that framework's values. The web
application reads the prefix from GET /config, so each chat's workflow ID names the SDK that runs it.
"""

import os
import sys
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Framework:
    name: str
    label: str
    task_queue: str  # the framework's default chat task queue (its worker's default)
    workflow_id_prefix: str


FRAMEWORKS = {
    framework.name: framework
    for framework in [
        Framework("openai_agents", "OpenAI Agents SDK", "OAI-Supervisor", "oai-temporal-agent-"),
        Framework("pyai", "Pydantic AI", "PYAI-Supervisor", "pyai-temporal-agent-"),
        Framework("strands_agents", "Strands Agents", "Strands-Supervisor", "strands-temporal-agent-"),
        Framework("google_adk", "Google ADK", "ADK-Supervisor", "adk-temporal-agent-"),
        Framework("pure", "Pure Python (LiteLLM)", "Pure-Supervisor", "pure-temporal-agent-"),
        Framework("vercel_ai", "Vercel AI SDK (TypeScript)", "VAI-Supervisor", "vai-temporal-agent-"),
        Framework("google_adk_ts", "Google ADK (TypeScript)", "ADK-TS-Supervisor", "adk-ts-temporal-agent-"),
        Framework("google_adk_go", "Google ADK (Go)", "ADK-Go-Supervisor", "adk-go-temporal-agent-"),
    ]
}


def valid_frameworks() -> str:
    """Every framework, one per line: its name, label and task queue."""
    width = max(map(len, FRAMEWORKS))
    return "\n".join(f"  {f.name:<{width}}  {f.label} (task queue {f.task_queue})" for f in FRAMEWORKS.values())


def problem(name: str) -> str | None:
    """Why ``name`` isn't a framework, or None if it is."""
    if not name:
        return "No AI framework given."
    if name not in FRAMEWORKS:
        return f"Unknown AI framework {name!r}."
    return None


def selected_framework() -> Framework:
    """The framework named by AI_FRAMEWORK, with CHAT_WORKFLOW_ID_PREFIX applied."""
    name = os.getenv("AI_FRAMEWORK", "")
    if error := problem(name):
        raise ValueError(f"{error} Set AI_FRAMEWORK to one of:\n{valid_frameworks()}")
    framework = FRAMEWORKS[name]
    prefix = os.getenv("CHAT_WORKFLOW_ID_PREFIX")
    return replace(framework, workflow_id_prefix=prefix) if prefix else framework


if __name__ == "__main__":
    # python -m api.frameworks <script> <framework>: the start scripts check their argument here,
    # before starting uvicorn, and stop with the list of frameworks if it isn't one.
    script, name = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
    if error := problem(name):
        print(f"{error} Usage: {script} <ai-framework>, where <ai-framework> is one of:\n{valid_frameworks()}",
              file=sys.stderr)
        sys.exit(2)
