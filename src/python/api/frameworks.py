"""Which AI frameworks the API serves: their task queues and the prefixes of their chat workflow IDs.

Each framework is one version of the demo (src/python/<framework>, or src/typescript/<framework> or
src/go/<framework> for a TypeScript or Go one, whose chat workflows follow the same Temporal contract). AI_FRAMEWORK picks
them: one framework (e.g. google_adk), several separated by commas (strands_agents,vercel_ai), or all. It has no default:
the start scripts require it as their argument (e.g. ./startlocalapi.sh google_adk) and, without a valid one, stop and
list every framework. The web application lists every framework the API serves in its sidebar, grouped by language.

With one framework, TEMPORAL_TASK_QUEUE and CHAT_WORKFLOW_ID_PREFIX override its values. With several, they would
give every framework the same queue and prefix, so they are ignored (the API says so when it starts).
"""

import os
import sys
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Framework:
    name: str
    label: str
    language: str  # Python, TypeScript or Go: the web UI's sidebar groups frameworks by it
    short_label: str  # the name within its language group, for the web UI's sidebar
    task_queue: str  # the framework's default chat task queue (its worker's default)
    workflow_id_prefix: str


FRAMEWORKS = {
    framework.name: framework
    for framework in [
        Framework("openai_agents", "OpenAI Agents SDK", "Python", "OpenAI Agents SDK", "OAI-Supervisor", "oai-temporal-agent-"),
        Framework("pyai", "Pydantic AI", "Python", "Pydantic AI", "PYAI-Supervisor", "pyai-temporal-agent-"),
        Framework("strands_agents", "Strands Agents", "Python", "Strands Agents", "Strands-Supervisor", "strands-temporal-agent-"),
        Framework("google_adk", "Google ADK", "Python", "Google ADK", "ADK-Supervisor", "adk-temporal-agent-"),
        Framework("pure", "Pure Python (LiteLLM)", "Python", "Pure Python (LiteLLM)", "Pure-Supervisor", "pure-temporal-agent-"),
        Framework("langgraph_agents", "LangGraph", "Python", "LangGraph", "LangGraph-Supervisor", "langgraph-temporal-agent-"),
        Framework("vercel_ai", "Vercel AI SDK (TypeScript)", "TypeScript", "Vercel AI SDK", "VAI-Supervisor", "vai-temporal-agent-"),
        Framework("google_adk_ts", "Google ADK (TypeScript)", "TypeScript", "Google ADK", "ADK-TS-Supervisor", "adk-ts-temporal-agent-"),
        Framework("google_adk_go", "Google ADK (Go)", "Go", "Google ADK", "ADK-Go-Supervisor", "adk-go-temporal-agent-"),
        Framework("spring_ai", "Spring AI (Java)", "Java", "Spring AI", "SpringAI-Supervisor", "springai-temporal-agent-"),
        Framework("strands_agents_ts", "Strands Agents (TypeScript)", "TypeScript", "Strands Agents", "Strands-TS-Supervisor", "strands-ts-temporal-agent-"),
        Framework("openai_agents_ts", "OpenAI Agents SDK (TypeScript)", "TypeScript", "OpenAI Agents SDK", "OAI-TS-Supervisor", "oai-ts-temporal-agent-"),
    ]
}


def valid_frameworks() -> str:
    """Every framework, one per line: its name, label and task queue."""
    width = max(map(len, FRAMEWORKS))
    return "\n".join(f"  {f.name:<{width}}  {f.label} (task queue {f.task_queue})" for f in FRAMEWORKS.values())


ALL = "all"
OVERRIDES = ("TEMPORAL_TASK_QUEUE", "CHAT_WORKFLOW_ID_PREFIX")


def names(value: str) -> list[str]:
    """The framework names in an AI_FRAMEWORK value: one name, names separated by commas, or all."""
    if value.strip().lower() == ALL:
        return list(FRAMEWORKS)
    return list(dict.fromkeys(name.strip() for name in value.split(",") if name.strip()))


def problem(value: str) -> str | None:
    """Why ``value`` doesn't name frameworks, or None if it does."""
    if not names(value):
        return "No AI framework given."
    unknown = [name for name in names(value) if name not in FRAMEWORKS]
    if unknown:
        return f"Unknown AI framework {', '.join(repr(name) for name in unknown)}."
    return None


def selected_frameworks() -> list[Framework]:
    """The frameworks AI_FRAMEWORK names, in its order. With just one, TEMPORAL_TASK_QUEUE and
    CHAT_WORKFLOW_ID_PREFIX override its task queue and prefix."""
    value = os.getenv("AI_FRAMEWORK", "")
    if error := problem(value):
        raise ValueError(f"{error} Set AI_FRAMEWORK to one of these, several separated by commas, or {ALL}:\n"
                         f"{valid_frameworks()}")
    frameworks = [FRAMEWORKS[name] for name in names(value)]
    if len(frameworks) == 1:
        framework = frameworks[0]
        queue, prefix = os.getenv("TEMPORAL_TASK_QUEUE"), os.getenv("CHAT_WORKFLOW_ID_PREFIX")
        frameworks = [replace(framework, task_queue=queue or framework.task_queue,
                              workflow_id_prefix=prefix or framework.workflow_id_prefix)]
    return frameworks


def ignored_overrides(frameworks: list[Framework]) -> list[str]:
    """The override settings that are set but ignored, because the API serves several frameworks."""
    return [name for name in OVERRIDES if os.getenv(name)] if len(frameworks) > 1 else []


if __name__ == "__main__":
    # python -m api.frameworks <script> <frameworks>: the start scripts check their argument here,
    # before starting uvicorn, and stop with the list of frameworks if it isn't one.
    script, name = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
    if error := problem(name):
        print(f"{error} Usage: {script} <ai-framework>, where <ai-framework> is one of these, several separated "
              f"by commas, or {ALL}:\n{valid_frameworks()}", file=sys.stderr)
        sys.exit(2)
