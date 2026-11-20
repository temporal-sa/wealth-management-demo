"""The conversation as a LangGraph graph: one node per agent, a tools node, and the edges between them.

    START --> (the active agent's node)
    supervisor_agent, beneficiary_agent, investment_agent, open_account_agent
        --> tools        when the model called tools or handed off
        --> END          when it answered the customer
    tools --> (the active agent's node, which a handoff may have changed)
          --> give_up    after MAX_MODEL_CALLS model calls in one customer message

One run of the graph handles one customer message. An agent node makes one model call with that
agent's instructions and tools. The tools node runs the tools the model asked for and follows
handoffs: a handoff makes another agent the active one, and the edge after the tools node routes
to it, so that agent answers the same message.

Both versions build the same graph (``build_graph``) with their own pieces:

* the standalone version (standalone/) runs it with plain LangGraph: the agent nodes call
  Gemini and the tools call the data managers directly;
* the Temporal version (durable/) runs it with Temporal's LangGraph plugin
  (temporalio-langgraph): each agent node runs as an activity, so every model call is durable,
  and the tools node runs in the chat workflow, where its tools run activities and start the
  open-account child workflow. The node ``metadata`` says which (``execute_in``) and sets the
  activity's timeout, retry policy and task queue; plain LangGraph ignores it.

The graph doesn't keep the conversation: the caller passes all the messages in each time and
keeps what comes back (the Temporal version keeps it in the chat workflow's state, so no
LangGraph checkpointer is needed).
"""

import json
import operator
from typing import Annotated, Any, Awaitable, Callable, Optional, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from lg_agents.agents import Agent, AgentContext, Tool, all_agents

# Model calls allowed for one customer message, so a model that keeps calling tools can't loop forever.
MAX_MODEL_CALLS = 10
GIVE_UP = "Sorry, I wasn't able to finish that request. Could you try again?"

TOOLS_NODE = "tools"
GIVE_UP_NODE = "give_up"

# The model call an agent node makes: (system prompt, messages, tool specs) -> the model's reply.
ModelCaller = Callable[[str, list[AnyMessage], list[dict]], Awaitable[AIMessage]]


class ChatState(TypedDict):
    # The whole conversation. A node returns only the messages it adds.
    messages: Annotated[list[AnyMessage], add_messages]
    # The name of the agent that takes the next model call.
    active_agent: str
    # Facts every agent is told on every model call (AgentContext.prompt_notes), such as the client ID.
    notes: list[str]
    # Model calls made for this customer message.
    model_calls: int
    # Handoffs and tool calls, and every tool's output, for this customer message.
    trace: Annotated[list[str], operator.add]
    tool_outputs: Annotated[list[str], operator.add]


def turn_input(messages: list[AnyMessage], active_agent: str, context: AgentContext) -> dict:
    """The graph's input for one customer message, already appended to ``messages``."""
    return {"messages": messages, "active_agent": active_agent, "notes": context.prompt_notes(),
            "model_calls": 0, "trace": [], "tool_outputs": []}


def reply_text(messages: list[AnyMessage], since: int) -> str:
    """What the agents said to the customer in the messages from index ``since`` on."""
    return "\n\n".join(m.text for m in messages[since:] if isinstance(m, AIMessage) and m.text)


def agent_node(agent: Agent, call_model: ModelCaller) -> Callable[[ChatState], Awaitable[dict]]:
    """An agent's node: one model call with the agent's instructions, the conversation and its tools."""
    async def run(state: ChatState) -> dict:
        reply = await call_model(agent.system_prompt(state["notes"]), state["messages"], agent.tool_specs())
        return {"messages": [reply], "model_calls": state["model_calls"] + 1}
    run.__name__ = agent.node_name
    return run


def _tool_output(result: Any) -> str:
    if result is None:
        return "Done."
    if isinstance(result, str):
        return result
    return json.dumps(result, default=lambda o: getattr(o, "__dict__", str(o)))


def _bind_error(tool: Tool, arguments: dict) -> Optional[str]:
    """Why the arguments don't fit the tool, or None if they do."""
    properties = tool.parameters["properties"]
    unknown = [a for a in arguments if a not in properties]
    missing = [r for r in tool.parameters["required"] if r not in arguments]
    if unknown or missing:
        return f"Error: invalid arguments for {tool.name}. Unknown: {unknown}. Missing: {missing}."
    return None


def tools_node(
    agents: dict[str, Agent],
    get_context: Callable[[], AgentContext],
    new_id: Callable[[], str],
    tool_errors: tuple[type[BaseException], ...] = (Exception,),
) -> Callable[[ChatState], Awaitable[dict]]:
    """The node that runs the tool calls in the model's last reply and follows its handoff.

    ``get_context`` returns the conversation's context: the tools read and change it, and its
    notes go to the next model call. ``new_id`` gives each tool result an ID (the Temporal
    version's are deterministic). Exceptions of a type in ``tool_errors`` raised by a tool go back
    to the model as the tool's output; anything else propagates.
    """
    async def tools(state: ChatState) -> dict:
        agent = agents[state["active_agent"]]
        context = get_context()
        calls = state["messages"][-1].tool_calls
        # Save the client ID from any call that has one before the tools run.
        for call in calls:
            if call["args"].get("client_id"):
                context.client_id = str(call["args"]["client_id"])

        handoffs = {a.handoff_tool_name: a for a in agent.handoffs}
        by_name = {t.name: t for t in agent.tools}
        next_agent = None
        messages, trace, outputs = [], [], []
        for call in calls:
            name, arguments = call["name"], call["args"]
            if name in handoffs:
                if next_agent is None:
                    next_agent = handoffs[name]
                    trace.append(f"Handed off from {agent.name} to {next_agent.name}")
                    output = json.dumps({"assistant": next_agent.name})
                else:
                    output = f"Ignored: the conversation was already handed off to the {next_agent.name}."
            elif name not in by_name:
                output = f"Error: there is no tool named {name}."
            else:
                tool = by_name[name]
                trace.append(f"{agent.name}: Calling a tool")
                output = _bind_error(tool, arguments)
                if output is None:
                    try:
                        value = await (tool.fn(context, **arguments) if tool.takes_context else tool.fn(**arguments))
                        output = _tool_output(value)
                    except tool_errors as e:
                        # Include the cause: a Temporal ActivityError only says "Activity task failed".
                        output = f"Error: {e}: {e.__cause__}" if e.__cause__ else f"Error: {e}"
                outputs.append(output)
            messages.append(ToolMessage(content=output, tool_call_id=call["id"], name=name, id=new_id()))
        return {"messages": messages, "active_agent": (next_agent or agent).name,
                "notes": context.prompt_notes(), "trace": trace, "tool_outputs": outputs}
    return tools


async def give_up(state: ChatState) -> dict:
    return {"messages": [AIMessage(GIVE_UP, id=f"give-up-{len(state['messages'])}")]}


def build_graph(
    supervisor: Agent,
    call_model: ModelCaller,
    tools: Callable[[ChatState], Awaitable[dict]],
    agent_metadata: Optional[dict] = None,
    tools_metadata: Optional[dict] = None,
) -> StateGraph:
    """The conversation graph for the agents reachable from ``supervisor``.

    ``agent_metadata`` and ``tools_metadata`` become the agent nodes' and the tools node's
    metadata: the Temporal version says there where each runs and with which activity options.
    """
    agents = all_agents(supervisor)
    node_of = {a.name: a.node_name for a in agents.values()}
    graph = StateGraph(ChatState)
    for agent in agents.values():
        graph.add_node(agent.node_name, agent_node(agent, call_model), metadata=dict(agent_metadata or {}))
    graph.add_node(TOOLS_NODE, tools, metadata=dict(tools_metadata or {}))
    graph.add_node(GIVE_UP_NODE, give_up, metadata=dict(tools_metadata or {}))

    # Edge functions run in the workflow in the Temporal version, so they only read the state, and
    # are async as the plugin requires.
    async def to_active_agent(state: ChatState) -> str:
        return node_of[state["active_agent"]]

    async def after_agent(state: ChatState) -> str:
        return TOOLS_NODE if state["messages"][-1].tool_calls else END

    async def after_tools(state: ChatState) -> str:
        if state["model_calls"] >= MAX_MODEL_CALLS:
            return GIVE_UP_NODE
        return node_of[state["active_agent"]]

    agent_nodes = list(node_of.values())
    graph.add_conditional_edges(START, to_active_agent, agent_nodes)
    for node in agent_nodes:
        graph.add_conditional_edges(node, after_agent, [TOOLS_NODE, END])
    graph.add_conditional_edges(TOOLS_NODE, after_tools, [*agent_nodes, GIVE_UP_NODE])
    graph.add_edge(GIVE_UP_NODE, END)
    return graph
