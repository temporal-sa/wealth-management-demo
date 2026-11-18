"""The chat workflow: one long-lived workflow per conversation, running the four agents.

The agent loop (common.agent_loop) runs here as ordinary workflow code. Every model call
is the invoke_model activity and every tool that touches a system is an activity, so a
worker crash, a model outage or a tool outage pauses the conversation instead of losing
it: Temporal replays the workflow to where it was and the turn carries on.

The conversation (messages, active agent, client ID, account openings) is workflow
state, so it is deterministic and survives replay.
"""

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Optional

from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError, ChildWorkflowError, WorkflowAlreadyStartedError
from temporalio.workflow import ParentClosePolicy

with workflow.unsafe.imports_passed_through():
    from common.account_context import UpdateAccountOpeningStateInput
    from common.agent_loop import Agent, AgentContext, ModelRequest, ModelResponse, all_agents, function_tool, run_turn
    from common.status_update import StatusUpdate
    from common.task_queues import TASK_QUEUE_LLM, TASK_QUEUE_OPEN_ACCOUNT
    from common.user_message import ChatInteraction, ProcessUserMessageInput
    from common.wealth_agents import build_agents
    from temporal_supervisor.activities.beneficiaries import Beneficiaries, Beneficiary
    from temporal_supervisor.activities.investments import Investments
    from temporal_supervisor.activities.model import invoke_model
    from temporal_supervisor.retry_policies import LLM_RETRY_POLICY, TOOL_RETRY_POLICY
    from temporal_supervisor.workflows.open_account_workflow import (
        OpenInvestmentAccountInput,
        OpenInvestmentAccountWorkflow,
    )

# One attempt of a tool activity. Retries are unlimited (TOOL_RETRY_POLICY), so an
# outage is waited out rather than timed out.
TOOL_TIMEOUT = timedelta(seconds=5)
# One attempt of a model call.
MODEL_TIMEOUT = timedelta(seconds=60)
# Errors a tool returns to the model as its output, instead of failing the workflow task.
TOOL_ERRORS = (ActivityError, ChildWorkflowError, WorkflowAlreadyStartedError)

CLIENT_ID = "The customer's client ID"
WORKFLOW_ID = "The workflow ID returned by open_new_investment_account"


@dataclass
class WealthManagementContext(AgentContext):
    # Latest state reported by each open-account child workflow, keyed by its
    # workflow ID. Updated by the update_account_opening_state signal.
    account_opening_states: dict[str, str] = field(default_factory=dict)
    # Number of the customer message being processed, and the message in which each
    # account opening's client details were shown, keyed by its workflow ID. Used to
    # check that the customer confirmed their details before KYC is approved.
    turn: int = 0
    kyc_details_shown_turn: dict[str, int] = field(default_factory=dict)
    # Number of account openings (open-account child workflows) started in this
    # conversation. The next opening's workflow ID ends with this number plus one.
    account_openings_started: int = 0
    # What each account opening is for ("Vacation with $13,500.00"), keyed by its workflow ID.
    account_opening_requests: dict[str, str] = field(default_factory=dict)

    def prompt_notes(self) -> list[str]:
        # Every agent is told the openings' current states on every model call. The
        # states arrive as signals, not in the conversation, and an agent that doesn't
        # know about them guesses: for example, the Investment Agent seeing one
        # "Vacation" account after two openings and assuming a duplicate is pending.
        notes = super().prompt_notes()
        if self.account_opening_requests:
            lines = "\n".join(f"    - {self.account_opening_requests[wf_id]} (workflow ID {wf_id}): "
                              f"{self.account_opening_states.get(wf_id, 'Initializing')}"
                              for wf_id in self.account_opening_requests)
            notes.append(
                "Account openings started in this conversation, oldest first, with the current status of each. "
                "These statuses are kept up to date for you and replace any status mentioned earlier in the "
                "conversation:\n" + lines + "\n"
                "    Each opening is separate and creates at most one account. \"Complete\" means it created "
                "an account, which list_investments shows. A status starting with \"Rolled back\" means it "
                "created no account and its deposit was refunded. Any other status means it is still in "
                "progress. Report these statuses as they are; don't guess or apologize for them.\n"
                "    A new request to open an account always starts another opening, even with a name used "
                "before: route it to the Open Account Agent as usual, without warning about duplicates or "
                "asking whether the customer is sure.")
        return notes


async def _activity(activity, *args, result_type=None):
    return await workflow.execute_activity(activity, args=list(args), start_to_close_timeout=TOOL_TIMEOUT,
                                           retry_policy=TOOL_RETRY_POLICY, result_type=result_type)

### Tools that run activities

@function_tool("List the beneficiaries for the given client ID.", client_id=CLIENT_ID)
async def list_beneficiaries(client_id: str) -> list:
    return await _activity(Beneficiaries.list_beneficiaries, client_id)


@function_tool("Add a beneficiary for the given client ID.", client_id=CLIENT_ID,
               first_name="The beneficiary's first name", last_name="The beneficiary's last name",
               relationship="The beneficiary's relationship to the customer, such as son or spouse")
async def add_beneficiary(client_id: str, first_name: str, last_name: str, relationship: str) -> str:
    await _activity(Beneficiaries.add_beneficiary, Beneficiary(client_id, first_name, last_name, relationship))
    return f"Beneficiary {first_name} {last_name} added."


@function_tool("Delete a beneficiary by its beneficiary ID.", client_id=CLIENT_ID,
               beneficiary_id="The beneficiary ID from list_beneficiaries")
async def delete_beneficiary(client_id: str, beneficiary_id: str) -> str:
    await _activity(Beneficiaries.delete_beneficiary, client_id, beneficiary_id)
    return f"Beneficiary {beneficiary_id} deleted."


@function_tool("List the investment accounts and balances for the given client ID.", client_id=CLIENT_ID)
async def list_investments(client_id: str) -> list:
    return await _activity(Investments.list_investments, client_id)


@function_tool("Close an investment account by its investment ID.", client_id=CLIENT_ID,
               investment_id="The investment ID from list_investments")
async def close_investment(client_id: str, investment_id: str) -> str:
    await _activity(Investments.close_investment, client_id, investment_id)
    return f"Investment account {investment_id} closed."


@function_tool("Update the customer's details for an account opening, which completes KYC. "
               "Pass only the fields that changed.",
               workflow_id=WORKFLOW_ID, first_name="New first name", last_name="New last name",
               address="New address", phone="New phone number", email="New email address",
               marital_status="New marital status")
async def update_client_details(workflow_id: str, first_name: Optional[str] = None, last_name: Optional[str] = None,
                                address: Optional[str] = None, phone: Optional[str] = None,
                                email: Optional[str] = None, marital_status: Optional[str] = None) -> str:
    changed = {k: v for k, v in dict(first_name=first_name, last_name=last_name, address=address, phone=phone,
                                     email=email, marital_status=marital_status).items() if v is not None}
    if not changed:
        return "Nothing was updated: pass at least one changed field."
    return await _activity("update_client_details", workflow_id, changed, result_type=str)

### Tools that use the conversation's state

@function_tool("Begin opening a new investment account. Returns the workflow ID of the account opening, "
               "which the other open-account tools require, or the reason the account cannot be opened.",
               client_id=CLIENT_ID, account_name="The name for the new investment account",
               initial_amount="The initial deposit amount")
async def open_new_investment_account(ctx: WealthManagementContext, client_id: str, account_name: str,
                                      initial_amount: float) -> str:
    initial_amount = float(initial_amount)
    # Business rules are checked up front. A violation is a non-retryable error:
    # it fails on the first attempt, and the reason goes back to the agent.
    try:
        await _activity(Investments.validate_new_account, client_id, account_name, initial_amount)
    except ActivityError as e:
        if isinstance(e.cause, ApplicationError):
            return f"The account cannot be opened: {e.cause.message}"
        raise

    # Read in an activity so the result is recorded in history and replays the same.
    promo_code = await _activity(Investments.find_promotion, client_id)

    # Every request starts a new account opening, even for an account name that was
    # opened, or is still being opened, earlier in the conversation. The ID ends with
    # the number of openings started in this conversation, counting this one.
    opening_number = ctx.account_openings_started + 1
    child_workflow_id = f"OpenAccount-{workflow.info().workflow_id}-{client_id}-{account_name}-{opening_number}"
    await workflow.start_child_workflow(
        OpenInvestmentAccountWorkflow.run,
        OpenInvestmentAccountInput(client_id=client_id, account_name=account_name,
                                   initial_amount=initial_amount, promo_code=promo_code),
        id=child_workflow_id,
        parent_close_policy=ParentClosePolicy.TERMINATE,
        task_queue=TASK_QUEUE_OPEN_ACCOUNT,
    )
    ctx.account_openings_started = opening_number
    ctx.account_opening_requests[child_workflow_id] = f"{account_name} with ${initial_amount:,.2f}"
    # Known from the start, so a status check right away doesn't report "not found"
    # before the child's first state update arrives.
    ctx.account_opening_states.setdefault(child_workflow_id, "Initializing")
    return child_workflow_id


@function_tool('Get the current status of an account opening. "Complete" means the account was opened; '
               'a status starting with "Rolled back" means it was not opened. Either way, that account '
               'opening is finished.', workflow_id=WORKFLOW_ID)
async def get_account_opening_status(ctx: WealthManagementContext, workflow_id: str) -> str:
    state = ctx.account_opening_states.get(workflow_id)
    if state is None:
        return f"No account opening with workflow ID {workflow_id} was found in this conversation."
    return state


@function_tool("Retrieve the customer's current details for an account opening, to show them for KYC.",
               workflow_id=WORKFLOW_ID)
async def get_current_client_info(ctx: WealthManagementContext, workflow_id: str) -> dict:
    client = await _activity("get_current_client_info", workflow_id, result_type=dict)
    ctx.kyc_details_shown_turn[workflow_id] = ctx.turn
    return client


@function_tool("Approve KYC for an account opening, after the customer confirmed their details are correct.",
               workflow_id=WORKFLOW_ID)
async def approve_kyc(ctx: WealthManagementContext, workflow_id: str) -> str:
    # The model sometimes treats a confirmation for an earlier account opening as
    # approval for a new one. Only approve once this opening's details have been
    # shown and the customer has replied since.
    shown_turn = ctx.kyc_details_shown_turn.get(workflow_id)
    if shown_turn is None or shown_turn >= ctx.turn:
        return ("KYC was not approved. First show the customer their current details for this account "
                "opening (get_current_client_info) and ask whether they are correct. Approve KYC only "
                "after the customer confirms in their next message.")
    await _activity("approve_kyc", workflow_id)
    return "KYC approved. The account is now waiting for compliance review."


def init_agents() -> Agent:
    """Create the four agents with the Temporal tools. Returns the Supervisor Agent."""
    return build_agents(
        beneficiary_tools=[list_beneficiaries, add_beneficiary, delete_beneficiary],
        investment_tools=[list_investments, close_investment],
        open_account_tools=[open_new_investment_account, get_account_opening_status, get_current_client_info,
                            approve_kyc, update_client_details],
    )


async def call_model(request: ModelRequest) -> ModelResponse:
    """Every model call is an activity, on its own task queue."""
    return await workflow.execute_activity(invoke_model, request, task_queue=TASK_QUEUE_LLM,
                                           start_to_close_timeout=MODEL_TIMEOUT, retry_policy=LLM_RETRY_POLICY)


@workflow.defn
class WealthManagementWorkflow:

    def __init__(self):
        self.agents = all_agents(init_agents())
        self.current_agent_name = init_agents().name
        self.context = WealthManagementContext()
        # The conversation, in the chat format the model sees.
        self.messages: list[dict] = []
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
            await workflow.wait_condition(
                lambda: bool(self.pending_chat_messages or self.pending_status_updates or self.ending))
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
            # This demo keeps the whole conversation in one workflow run. A production system
            # would call continue-as-new when workflow.info().is_continue_as_new_suggested()
            # returns true, because every model and tool call adds events to the history. To do
            # it safely: wait for workflow.all_handlers_finished() and drain both queues; carry
            # the messages, the active agent and the context (client ID, account-opening states,
            # openings started, KYC turn tracking) into the new run; and since the open-account
            # children use ParentClosePolicy.TERMINATE, which also applies on continue-as-new,
            # either defer it while an opening is in progress or switch to ABANDON and have
            # end_workflow terminate any opening still running.

    async def _process_chat_message(self, message: str) -> None:
        workflow.logger.info(f"Processing chat message: {message}")
        self.context.turn += 1
        self.messages.append({"role": "user", "content": message})
        result = await run_turn(self.agents[self.current_agent_name], self.messages, self.context,
                                call_model, tool_errors=TOOL_ERRORS)
        self.current_agent_name = result.agent.name

        interaction = ChatInteraction(user_prompt=message, text_response=result.text_response,
                                      json_response=result.json_response, agent_trace=result.agent_trace)
        self.chat_history.append(interaction)
        workflow.set_current_details(f"**Active agent:** {self.current_agent_name}\n\n"
                                     f"**Customer:** {message}\n\n**Reply:** {result.text_response}")
        await self._local_activity("append_chat_interaction", workflow.info().workflow_id, interaction)

    async def _local_activity(self, name: str, *args):
        # Publishing to the UI's event stream (Redis). Retried until Redis is reachable.
        return await workflow.execute_local_activity(name, args=list(args), start_to_close_timeout=TOOL_TIMEOUT,
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
