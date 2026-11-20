"""The four agents, their tools and their handoffs, shared by the standalone and Temporal versions.

An ``Agent`` has instructions, tools and the agents it can hand off to. Each agent is a node in
the LangGraph graph (lg_agents.graph). A handoff is offered to the model as one more tool,
``transfer_to_<agent_name>``: when the model calls it, the graph's tools node makes that agent the
active one and the graph routes to its node, so the agent the conversation is handed to answers
the same customer message.

    Supervisor Agent   -> Beneficiary Agent, Investment Agent
    Beneficiary Agent  -> Supervisor Agent
    Investment Agent   -> Open Account Agent, Supervisor Agent
    Open Account Agent -> Investment Agent

Each version supplies the tools: the standalone version's call the data managers directly, the
Temporal version's run activities and start the open-account child workflow.
"""

import inspect
import re
import types
import typing
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

from prompts.agent_constants import (
    BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS,
    INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS,
    OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_HANDOFF, OPEN_ACCOUNT_INSTRUCTIONS,
    SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS,
)

_JSON_TYPES = {str: "string", float: "number", int: "integer", bool: "boolean", dict: "object", list: "array"}


@dataclass
class Tool:
    name: str
    description: str
    # JSON schema of the arguments.
    parameters: dict
    fn: Callable[..., Awaitable[Any]]
    # Whether fn takes the conversation context as its first argument (named ctx).
    takes_context: bool = False

    def spec(self) -> dict:
        """The tool as the model sees it (the OpenAI function format, which LangChain's bind_tools takes)."""
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


def _json_type(annotation) -> str:
    # Optional[X] and X | None describe X.
    if typing.get_origin(annotation) in (Union, types.UnionType):
        annotation = next(a for a in typing.get_args(annotation) if a is not type(None))
    return _JSON_TYPES[typing.get_origin(annotation) or annotation]


def function_tool(description: str, name: Optional[str] = None, **param_descriptions: str):
    """Make a tool from an async function. The JSON schema comes from its signature.

    Parameters without a default are required. A first parameter named ``ctx`` receives the
    conversation context and is not shown to the model.

        @function_tool("List the customer's beneficiaries.", client_id="The customer's client ID")
        async def list_beneficiaries(client_id: str) -> list: ...
    """
    def wrap(fn: Callable[..., Awaitable[Any]]) -> Tool:
        hints = typing.get_type_hints(fn)
        params = list(inspect.signature(fn).parameters.values())
        takes_context = bool(params) and params[0].name == "ctx"
        properties, required = {}, []
        for p in params[1:] if takes_context else params:
            properties[p.name] = {"type": _json_type(hints[p.name]), "description": param_descriptions.get(p.name, "")}
            if p.default is inspect.Parameter.empty:
                required.append(p.name)
        schema = {"type": "object", "properties": properties, "required": required}
        return Tool(name or fn.__name__, description, schema, fn, takes_context)
    return wrap


@dataclass
class AgentContext:
    """State shared by all the agents in a conversation, kept outside the graph's messages."""
    # The customer's client ID, once a tool has been called with it, so that every agent is told
    # it and none asks for it again.
    client_id: Optional[str] = None

    def prompt_notes(self) -> list[str]:
        """Facts every agent is told at the end of its instructions, on every model call."""
        if self.client_id is None:
            return []
        return [f"The customer's client ID is {self.client_id}. Use it, and don't ask for it again."]


def slug(name: str) -> str:
    return re.sub(r"\W+", "_", name.lower()).strip("_")


@dataclass
class Agent:
    name: str
    # Shown to other agents as the description of the handoff tool to this agent.
    handoff_description: str
    instructions: str
    tools: list[Tool] = field(default_factory=list)
    handoffs: list["Agent"] = field(default_factory=list)

    @property
    def node_name(self) -> str:
        """The agent's node in the graph, such as supervisor_agent."""
        return slug(self.name)

    @property
    def handoff_tool_name(self) -> str:
        return "transfer_to_" + slug(self.name)

    def system_prompt(self, notes: list[str]) -> str:
        """The agent's instructions, plus the conversation's notes, such as the client ID once it is known.

        The ID is otherwise only in the conversation history, and an agent that is handed the
        conversation often asks for it again.
        """
        if not notes:
            return self.instructions
        return "\n".join([self.instructions, *(f"    {note}" for note in notes)])

    def tool_specs(self) -> list[dict]:
        handoffs = [{"type": "function",
                     "function": {"name": a.handoff_tool_name,
                                  "description": f"Handoff to the {a.name}. {a.handoff_description}",
                                  "parameters": {"type": "object", "properties": {}, "required": []}}}
                    for a in self.handoffs]
        return [t.spec() for t in self.tools] + handoffs


def all_agents(start: Agent) -> dict[str, Agent]:
    """Every agent reachable from ``start`` through handoffs, by name, ``start`` first."""
    found: dict[str, Agent] = {}
    pending = [start]
    while pending:
        agent = pending.pop(0)
        if agent.name not in found:
            found[agent.name] = agent
            pending.extend(agent.handoffs)
    return found


def build_agents(
    beneficiary_tools: list[Tool],
    investment_tools: list[Tool],
    open_account_tools: list[Tool],
    open_account_instructions: str = OPEN_ACCOUNT_INSTRUCTIONS,
) -> Agent:
    """Create the agents and return the Supervisor Agent, which takes the first message."""
    beneficiary_agent = Agent(BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS, beneficiary_tools)
    investment_agent = Agent(INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS, investment_tools)
    open_account_agent = Agent(OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_HANDOFF, open_account_instructions,
                               open_account_tools)
    supervisor_agent = Agent(SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS,
                             handoffs=[beneficiary_agent, investment_agent])

    beneficiary_agent.handoffs.append(supervisor_agent)
    investment_agent.handoffs.extend([open_account_agent, supervisor_agent])
    open_account_agent.handoffs.append(investment_agent)
    return supervisor_agent
