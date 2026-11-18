"""A minimal multi-agent loop in plain Python: agents, tools and handoffs, with no agent framework.

An ``Agent`` has instructions, tools and the agents it can hand off to. A handoff is
offered to the model as one more tool, ``transfer_to_<agent_name>``. When the model calls
it, the loop switches the active agent and carries on in the same turn, so the agent the
conversation is handed to answers the same customer message.

``run_turn`` runs one customer message to completion: it calls the model, runs the tools
the model asks for, follows handoffs, and stops when the model replies without calling a
tool. It does no I/O of its own. The model call and every tool are async functions passed
in by the caller:

* the standalone version (pure_supervisor) calls LiteLLM and the data managers directly;
* the Temporal version (temporal_supervisor) runs them as activities, so the same loop
  runs as deterministic workflow code and every model and tool call is durable.

Messages are kept in the OpenAI chat format, which LiteLLM translates for every provider.
"""

import inspect
import json
import re
import types
import typing
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

# ---------------------------------------------------------------------------
# Model calls
# ---------------------------------------------------------------------------


@dataclass
class ModelRequest:
    """One call to the model: the active agent's instructions, the conversation and its tools."""
    system: str
    messages: list[dict]
    tools: list[dict]
    # A LiteLLM model name. None uses the configured model (LLM_MODEL).
    model: Optional[str] = None


@dataclass
class ToolCall:
    id: str
    name: str
    # JSON-encoded arguments, as the model produced them.
    arguments: str


@dataclass
class ModelResponse:
    """What the model returned: text for the customer, tool calls, or both."""
    content: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)


ModelCaller = Callable[[ModelRequest], Awaitable[ModelResponse]]

# ---------------------------------------------------------------------------
# Tools and agents
# ---------------------------------------------------------------------------

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
        """The tool in the OpenAI chat format, which LiteLLM translates for each provider."""
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


def _json_type(annotation) -> str:
    # Optional[X] and X | None describe X.
    if typing.get_origin(annotation) in (Union, types.UnionType):
        annotation = next(a for a in typing.get_args(annotation) if a is not type(None))
    return _JSON_TYPES[typing.get_origin(annotation) or annotation]


def function_tool(description: str, name: Optional[str] = None, **param_descriptions: str):
    """Make a tool from an async function. The JSON schema comes from its signature.

    Parameters without a default are required. A first parameter named ``ctx`` receives
    the conversation context and is not shown to the model.

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
    """State shared by all the agents in a conversation."""
    # The customer's client ID, once a tool has been called with it, so that every
    # agent is told it and none asks for it again.
    client_id: Optional[str] = None

    def prompt_notes(self) -> list[str]:
        """Facts every agent is told at the end of its instructions, on every model call."""
        if self.client_id is None:
            return []
        return [f"The customer's client ID is {self.client_id}. Use it, and don't ask for it again."]


@dataclass
class Agent:
    name: str
    # Shown to other agents as the description of the handoff tool to this agent.
    handoff_description: str
    instructions: str
    tools: list[Tool] = field(default_factory=list)
    handoffs: list["Agent"] = field(default_factory=list)

    @property
    def handoff_tool_name(self) -> str:
        return "transfer_to_" + re.sub(r"\W+", "_", self.name.lower()).strip("_")

    def system_prompt(self, context: AgentContext) -> str:
        """The agent's instructions, plus the context's notes, such as the client ID once it is known.

        The ID is otherwise only in the conversation history, and an agent that is
        handed the conversation often asks for it again.
        """
        notes = context.prompt_notes()
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
    """Every agent reachable from ``start`` through handoffs, by name."""
    found: dict[str, Agent] = {}
    pending = [start]
    while pending:
        agent = pending.pop()
        if agent.name not in found:
            found[agent.name] = agent
            pending.extend(agent.handoffs)
    return found

# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------


@dataclass
class TurnResult:
    # The agent that answered last, which takes the customer's next message.
    agent: Agent
    # Everything the agents said to the customer in this turn.
    text_response: str = ""
    # The output of every tool called in this turn, one per line.
    json_response: str = ""
    # Handoffs and tool calls, one per line.
    agent_trace: str = ""


def _tool_output(result: Any) -> str:
    if result is None:
        return "Done."
    if isinstance(result, str):
        return result
    return json.dumps(result, default=lambda o: getattr(o, "__dict__", str(o)))


def _bind(tool: Tool, arguments: dict) -> Optional[str]:
    """Why the arguments don't fit the tool, or None if they do."""
    properties = tool.parameters["properties"]
    unknown = [a for a in arguments if a not in properties]
    missing = [r for r in tool.parameters["required"] if r not in arguments]
    if unknown or missing:
        return f"Error: invalid arguments for {tool.name}. Unknown: {unknown}. Missing: {missing}."
    return None


async def run_turn(
    agent: Agent,
    messages: list[dict],
    context: AgentContext,
    call_model: ModelCaller,
    tool_errors: tuple[type[BaseException], ...] = (Exception,),
    max_model_calls: int = 10,
) -> TurnResult:
    """Run one customer message, already appended to ``messages``, to completion.

    ``messages`` is extended in place with the model's replies and the tool results.
    Exceptions of a type in ``tool_errors`` raised by a tool are returned to the model
    as the tool's output; anything else propagates.
    """
    result = TurnResult(agent=agent)
    for _ in range(max_model_calls):
        response = await call_model(ModelRequest(system=agent.system_prompt(context),
                                                 messages=list(messages),
                                                 tools=agent.tool_specs()))

        assistant: dict[str, Any] = {"role": "assistant", "content": response.content}
        if response.tool_calls:
            assistant["tool_calls"] = [{"id": c.id, "type": "function",
                                        "function": {"name": c.name, "arguments": c.arguments}}
                                       for c in response.tool_calls]
        messages.append(assistant)
        if response.content:
            result.text_response += response.content

        if not response.tool_calls:
            result.agent = agent
            return result

        # Parse every call first, and save the client ID from any call that has one
        # before the tools run.
        calls = []
        for call in response.tool_calls:
            try:
                arguments = json.loads(call.arguments or "{}")
                if not isinstance(arguments, dict):
                    raise ValueError("arguments must be a JSON object")
            except ValueError as e:
                arguments = e
            else:
                if arguments.get("client_id"):
                    context.client_id = str(arguments["client_id"])
            calls.append((call, arguments))

        next_agent = None
        handoffs = {a.handoff_tool_name: a for a in agent.handoffs}
        tools = {t.name: t for t in agent.tools}
        for call, arguments in calls:
            if call.name in handoffs:
                if next_agent is None:
                    next_agent = handoffs[call.name]
                    result.agent_trace += f"Handed off from {agent.name} to {next_agent.name}\n"
                    output = json.dumps({"assistant": next_agent.name})
                else:
                    output = f"Ignored: the conversation was already handed off to the {next_agent.name}."
            elif call.name not in tools:
                output = f"Error: there is no tool named {call.name}."
            elif isinstance(arguments, ValueError):
                output = f"Error: the arguments for {call.name} are not valid JSON: {arguments}"
            else:
                tool = tools[call.name]
                result.agent_trace += f"{agent.name}: Calling a tool\n"
                output = _bind(tool, arguments)
                if output is None:
                    try:
                        value = await (tool.fn(context, **arguments) if tool.takes_context else tool.fn(**arguments))
                        output = _tool_output(value)
                    except tool_errors as e:
                        # Include the cause: a Temporal ActivityError only says "Activity task failed".
                        output = f"Error: {e}: {e.__cause__}" if e.__cause__ else f"Error: {e}"
                result.json_response += output + "\n"
            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})

        if next_agent is not None:
            agent = next_agent

    result.agent = agent
    result.text_response += "Sorry, I wasn't able to finish that request. Could you try again?"
    return result
