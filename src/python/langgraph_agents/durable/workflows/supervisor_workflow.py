"""The chat workflow: one long-lived workflow per conversation, running the agents' LangGraph graph.

Each customer message is one run of the graph (durable/workflows/chat_graph.py), through
Temporal's LangGraph plugin: every agent node is an activity, so every model call is durable, and
the tools node runs here, where its tools run activities and start the open-account child
workflow. A worker crash, a model outage or a tool outage pauses the conversation instead of losing
it: Temporal replays the workflow to where it was and the message carries on.

The conversation (messages, active agent, client ID, account openings) is workflow state, so it is
deterministic and survives replay, and LangGraph needs no checkpointer.
"""

import asyncio
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from langchain_core.messages import AnyMessage, HumanMessage
    from temporalio.langgraph import graph

    from common.account_context import UpdateAccountOpeningStateInput
    from common.chat_idle import CHAT_IDLE_TIMEOUT, chat_idle_timeout
    from common.status_update import StatusUpdate
    from common.user_message import ChatInteraction, ProcessUserMessageInput
    from durable.retry_policies import TOOL_RETRY_POLICY
    from durable.workflows.chat_graph import GRAPH_NAME, WealthManagementContext
    from lg_agents.graph import reply_text, turn_input
    from prompts.agent_constants import SUPERVISOR_AGENT_NAME

# One attempt of publishing to the UI's event stream.
EVENT_TIMEOUT = timedelta(seconds=5)


@workflow.defn
class WealthManagementWorkflow:

    def __init__(self):
        self.current_agent_name = SUPERVISOR_AGENT_NAME
        self.context = WealthManagementContext()
        # The conversation, as LangChain messages.
        self.messages: list[AnyMessage] = []
        self.chat_history: list[ChatInteraction] = []
        self.pending_chat_messages: list[str] = []
        self.pending_status_updates: list[str] = []
        self.ending = False

    @workflow.run
    async def run(self):
        # Delete any earlier conversation stored under this ID: the demo UI reuses chat IDs.
        wf_id = workflow.info().workflow_id
        workflow.logger.info(f"Deleting any previous conversation {wf_id}")
        await self._local_activity("delete_conversation", wf_id)

        while True:
            try:
                await workflow.wait_condition(
                    lambda: bool(self.pending_chat_messages or self.pending_status_updates or self.ending),
                    timeout=chat_idle_timeout(),
                )
            except asyncio.TimeoutError:
                # Nobody has used this chat for a while (e.g. the tab was closed without End Chat)
                workflow.logger.info(f"Ending chat: idle for {CHAT_IDLE_TIMEOUT}")
                return
            if self.ending:
                workflow.logger.info("Ending workflow.")
                return

            # One customer message, then one status update, at a time.
            if self.pending_chat_messages:
                await self._process_chat_message(self.pending_chat_messages.pop(0))
            if self.pending_status_updates:
                status_message = self.pending_status_updates.pop(0)
                await self._local_activity("append_status_update", wf_id, StatusUpdate(status=status_message))

            # TODO: Continue-As-New.
            # This demo keeps the whole conversation in one workflow run. A production system would
            # call continue-as-new when workflow.info().is_continue_as_new_suggested() returns true,
            # because every model and tool call adds events to the history: wait for
            # workflow.all_handlers_finished(), drain both queues, carry the messages, the active
            # agent and the context into the new run, and mind that the open-account children use
            # ParentClosePolicy.TERMINATE, which also applies on continue-as-new.

    async def _process_chat_message(self, message: str) -> None:
        workflow.logger.info(f"Processing chat message: {message}")
        self.context.turn += 1
        turn_start = len(self.messages)
        self.messages.append(HumanMessage(message, id=str(workflow.uuid4())))
        result = await graph(GRAPH_NAME).compile().ainvoke(
            turn_input(self.messages, self.current_agent_name, self.context))
        self.messages = result["messages"]
        self.current_agent_name = result["active_agent"]

        text = reply_text(self.messages, turn_start + 1)
        trace = "".join(f"{line}\n" for line in result["trace"])
        outputs = "".join(f"{line}\n" for line in result["tool_outputs"])
        interaction = ChatInteraction(user_prompt=message, text_response=text, json_response=outputs,
                                      agent_trace=trace)
        self.chat_history.append(interaction)
        workflow.set_current_details(f"**Active agent:** {self.current_agent_name}\n\n"
                                     f"**Customer:** {message}\n\n**Reply:** {text}")
        await self._local_activity("append_chat_interaction", workflow.info().workflow_id, interaction)

    async def _local_activity(self, name: str, *args):
        # Publishing to the UI's event stream (Redis). Retried until Redis is reachable.
        return await workflow.execute_local_activity(name, args=list(args), start_to_close_timeout=EVENT_TIMEOUT,
                                                     retry_policy=TOOL_RETRY_POLICY)

    @workflow.query
    def get_chat_history(self) -> list[ChatInteraction]:
        return self.chat_history

    @workflow.signal
    async def end_workflow(self) -> None:
        self.ending = True

    @workflow.signal
    async def update_account_opening_state(self, state_input: UpdateAccountOpeningStateInput) -> None:
        workflow.logger.info(f"Account opening state changed: {state_input.account_name} {state_input.state}")
        if state_input.workflow_id is not None:
            self.context.account_opening_states[state_input.workflow_id] = state_input.state
        self.pending_status_updates.append(f"New {state_input.account_name} account status changed: {state_input.state}")

    @workflow.signal
    async def process_user_message(self, message_input: ProcessUserMessageInput) -> None:
        workflow.logger.info(f"Received user message {message_input}")
        self.pending_chat_messages.append(message_input.user_input)
