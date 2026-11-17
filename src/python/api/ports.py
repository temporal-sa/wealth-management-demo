"""Which port the API serves: its task queue and the prefix of its chat workflow IDs.

CHAT_PORT picks the port (default "openai_agents"); the start scripts set it from their
optional argument, e.g. ./startlocalapi.sh pyai. TEMPORAL_TASK_QUEUE and
CHAT_WORKFLOW_ID_PREFIX override that port's values. The web application reads the
prefix from GET /config, so each chat's workflow ID names the SDK that runs it.
"""

import os
from dataclasses import dataclass


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
    ]
}
DEFAULT_PORT = "openai_agents"


def selected_port() -> Port:
    """The port named by CHAT_PORT, with CHAT_WORKFLOW_ID_PREFIX applied."""
    name = os.getenv("CHAT_PORT") or DEFAULT_PORT
    if name not in PORTS:
        raise ValueError(f"Unknown CHAT_PORT {name!r}; expected one of: {', '.join(PORTS)}")
    port = PORTS[name]
    prefix = os.getenv("CHAT_WORKFLOW_ID_PREFIX")
    return Port(port.name, port.label, port.task_queue, prefix) if prefix else port
