"""Which port the API serves: its task queue and the prefix of its chat workflow IDs.

CHAT_PORT picks the port. It has no default: the start scripts require the port as their
argument (e.g. ./startlocalapi.sh google_adk) and, without a valid one, stop and list every port.
TEMPORAL_TASK_QUEUE and CHAT_WORKFLOW_ID_PREFIX override that port's values. The web application reads the
prefix from GET /config, so each chat's workflow ID names the SDK that runs it.
"""

import os
import sys
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Port:
    name: str
    label: str
    task_queue: str  # the port's default chat task queue (its worker's default)
    workflow_id_prefix: str


PORTS = {
    port.name: port
    for port in [
        Port("openai_agents", "OpenAI Agents SDK", "Supervisor", "oai-temporal-agent-"),
        Port("pyai", "Pydantic AI", "PY-AI-Supervisor", "pyai-temporal-agent-"),
        Port("strands_agents", "Strands Agents", "wealth-management-strands", "strands-temporal-agent-"),
        Port("google_adk", "Google ADK", "ADK-Supervisor", "adk-temporal-agent-"),
    ]
}


def valid_ports() -> str:
    """Every port, one per line: its name, label and task queue."""
    width = max(map(len, PORTS))
    return "\n".join(f"  {p.name:<{width}}  {p.label} (task queue {p.task_queue})" for p in PORTS.values())


def problem(name: str) -> str | None:
    """Why ``name`` isn't a port, or None if it is."""
    if not name:
        return "No port given."
    if name not in PORTS:
        return f"Unknown port {name!r}."
    return None


def selected_port() -> Port:
    """The port named by CHAT_PORT, with CHAT_WORKFLOW_ID_PREFIX applied."""
    name = os.getenv("CHAT_PORT", "")
    if error := problem(name):
        raise ValueError(f"{error} Set CHAT_PORT to one of:\n{valid_ports()}")
    port = PORTS[name]
    prefix = os.getenv("CHAT_WORKFLOW_ID_PREFIX")
    return replace(port, workflow_id_prefix=prefix) if prefix else port


if __name__ == "__main__":
    # python -m api.ports <script> <port>: the start scripts check their argument here, before
    # starting uvicorn, and stop with the list of ports if it isn't one.
    script, name = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
    if error := problem(name):
        print(f"{error} Usage: {script} <port>, where <port> is one of:\n{valid_ports()}", file=sys.stderr)
        sys.exit(2)
