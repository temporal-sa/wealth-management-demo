import asyncio
from datetime import timedelta
from typing import List, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.workflow import ParentClosePolicy

from common.user_message import ProcessUserMessageInput, ChatInteraction
from common.status_update import StatusUpdate
from common.account_context import UpdateAccountOpeningStateInput
from prompts.agent_constants import (
    BENE_INSTRUCTIONS,
    OPEN_ACCOUNT_INSTRUCTIONS,
    TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS,
    TEMPORAL_SUPERVISOR_INSTRUCTIONS,
)
from durable.activities.event_stream_activities import EventStreamActivities
from durable.retry_policies import LLM_RETRY_POLICY, TOOL_RETRY_POLICY

with workflow.unsafe.imports_passed_through():
    from strands import tool
    from strands.hooks import HookProvider, HookRegistry, BeforeToolCallEvent
    from temporalio.contrib.strands import TemporalAgent
    from temporalio.contrib.strands.workflow import activity_as_tool
    from durable.model_config import LLM_TASK_QUEUE, MODEL_NAME, OPEN_ACCOUNT_TASK_QUEUE
    from durable.activities.beneficiaries import Beneficiaries
    from durable.activities.investments import Investments
    from durable.activities.open_account import OpenAccount
    from durable.workflows.open_account_workflow import (
        OpenInvestmentAccountWorkflow,
        OpenInvestmentAccountInput,
    )

ACTIVITY_TIMEOUT = timedelta(seconds=30)
MODEL_TIMEOUT = timedelta(seconds=90)


def _activity_tool(activity_fn):
    """Expose an activity to an agent as a tool, retrying until its system recovers."""
    return activity_as_tool(activity_fn, start_to_close_timeout=ACTIVITY_TIMEOUT, retry_policy=TOOL_RETRY_POLICY)


# Tools that delete or close something, so the customer must confirm them in the chat first.
CONFIRMATION_REQUIRED_TOOLS = {"delete_beneficiary", "close_investment"}

NOT_CONFIRMED = (
    "Not done: the customer has not confirmed this yet. Ask the customer \"{question}\" and stop. "
    "Call {tool} again only after the customer says yes in their next message."
)
CONFIRMATION_QUESTIONS = {
    "delete_beneficiary": "Are you sure you want to delete beneficiary <first and last name>?",
    "close_investment": "Are you sure you want to close your <account name> account?",
}


def confirmed(asked_turn: Optional[int], turn: int) -> bool:
    """Whether the customer was asked to confirm this exact call in their previous message.

    Like the other frameworks, deleting a beneficiary or closing an account is confirmed in
    the chat: the agent asks, and the customer's next message answers. The first call
    is refused with a request to ask (NOT_CONFIRMED); the same call in the customer's
    next turn runs. A call in the same turn as the question, or for a question asked
    earlier in the conversation, is refused and asked again.
    """
    return asked_turn is not None and asked_turn == turn - 1


class ConfirmationGuard(HookProvider):
    """Refuses a delete or close until the customer has confirmed it in the chat.

    Registered on the sub-agents that own delete_beneficiary and close_investment.
    The hook runs in workflow context, so it only reads and writes workflow state.
    """

    def __init__(self, owner: "WealthManagementWorkflow"):
        self._owner = owner

    def register_hooks(self, registry: HookRegistry, **kwargs: object) -> None:
        registry.add_callback(BeforeToolCallEvent, self._gate)

    def _gate(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use["name"]
        if name not in CONFIRMATION_REQUIRED_TOOLS:
            return
        key = (name, tuple(sorted((k, str(v)) for k, v in dict(event.tool_use["input"]).items())))
        asked = self._owner._confirmations_asked
        if confirmed(asked.get(key), self._owner._turn):
            del asked[key]
            return
        asked[key] = self._owner._turn
        event.cancel_tool = NOT_CONFIRMED.format(question=CONFIRMATION_QUESTIONS[name], tool=name)


# ---------------------------------------------------------------------------
# In-workflow tools (run deterministically in the workflow sandbox).
# ---------------------------------------------------------------------------
KYC_NOT_APPROVED = (
    "KYC was not approved. First show the customer their current details for this account "
    "opening (get_current_client_info) and ask whether they are correct. Approve KYC only "
    "after the customer confirms in their next message."
)


def kyc_confirmed(shown_turn: Optional[int], turn: int) -> bool:
    """Whether an account opening's details were shown in an earlier customer turn.

    The model sometimes treats a confirmation for an earlier account opening as
    approval for a new one, or approves in the same turn it shows the details.
    KYC may only be approved once this opening's details have been shown and the
    customer has replied since.
    """
    return shown_turn is not None and shown_turn < turn


@tool
async def update_client_details(
    workflow_id: str,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    address: Optional[str] = None,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    marital_status: Optional[str] = None,
) -> str:
    """Update one or more client fields during account opening (also completes KYC).

    Args:
        workflow_id: The open-account child workflow ID from open_new_investment_account.
        first_name: New first name (omit to leave unchanged).
        last_name: New last name (omit to leave unchanged).
        address: New address (omit to leave unchanged).
        phone: New phone number (omit to leave unchanged).
        email: New email address (omit to leave unchanged).
        marital_status: New marital status (omit to leave unchanged).
    """
    fields = {
        k: v
        for k, v in {
            "first_name": first_name,
            "last_name": last_name,
            "address": address,
            "phone": phone,
            "email": email,
            "marital_status": marital_status,
        }.items()
        if v is not None
    }
    return await workflow.execute_activity(
        OpenAccount.update_client_details,
        args=[workflow_id, fields],
        start_to_close_timeout=ACTIVITY_TIMEOUT,
        retry_policy=TOOL_RETRY_POLICY,
    )


@workflow.defn
class WealthManagementWorkflow:
    def __init__(self):
        self.wf_id: Optional[str] = None
        self.pending_chat_messages: asyncio.Queue = asyncio.Queue()
        self.pending_status_updates: asyncio.Queue = asyncio.Queue()
        self.chat_history: List[ChatInteraction] = []
        self.status_updates: List[str] = []
        self.end_workflow_flag = False
        self._agent: Optional[TemporalAgent] = None
        # The customer turn in which each delete or close was refused so the agent
        # could ask the customer to confirm it (see ConfirmationGuard).
        self._confirmations_asked: dict = {}
        # Long-lived sub-agents that must own multi-turn state (the open-account
        # agent owns its child-workflow ID), keyed by a stable name rather than by
        # tool_use id so the same agent is reused across supervisor turns.
        self._persistent_subagents: dict = {}
        # Latest state and account name reported by each open-account child
        # workflow (see update_account_opening_state), so the open-account agent
        # gets the real status instead of relying on what it remembers.
        self._account_opening_states: dict = {}
        self._account_opening_names: dict = {}
        # Number of account openings started in this conversation. Each opening's
        # child workflow ID ends with its number, so every request to open an
        # account starts a new child workflow, even for the same account name.
        self._account_openings_started = 0
        # Number of the customer message being processed, and the message in which
        # each account opening's client details were shown, keyed by its workflow
        # ID. Used to check that the customer confirmed their details before KYC is
        # approved (see kyc_confirmed).
        self._turn = 0
        self._kyc_details_shown_turn: dict = {}
        self.local_to_close_timeout = timedelta(seconds=10)
        self.retry_policy = RetryPolicy(
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2,
            maximum_interval=timedelta(seconds=30),
        )

    # ----- Specialized sub-agents (the "agents as tools" pattern) -----
    async def _run_subagent(
        self,
        *,
        client_id: str,
        request: str,
        system_prompt: str,
        tools: list,
        persistent_key: Optional[str] = None,
    ) -> str:
        """Build (or reuse) a specialized sub-agent and run it.

        When ``persistent_key`` is given, the sub-agent is long-lived: it is built
        once and reused across supervisor turns (from ``self._persistent_subagents``)
        so it can own multi-turn state: the question it asked the customer (to
        confirm a delete or close, or their KYC details) and the open-account
        child-workflow ID. Ordinary sub-agents are rebuilt per call.
        """
        if persistent_key is not None and persistent_key in self._persistent_subagents:
            # A later turn of a multi-turn flow: reuse the same agent so its message
            # history (and the child-workflow ID it holds) carries over.
            sub = self._persistent_subagents[persistent_key]
        else:
            sub = TemporalAgent(
                model=MODEL_NAME,
                task_queue=LLM_TASK_QUEUE,
                start_to_close_timeout=MODEL_TIMEOUT,
                retry_policy=LLM_RETRY_POLICY,
                system_prompt=system_prompt,
                tools=tools,
                hooks=[ConfirmationGuard(self)],
            )
            if persistent_key is not None:
                self._persistent_subagents[persistent_key] = sub
        return str(await sub.invoke_async(f"The client ID is {client_id}. {request}"))

    def _make_beneficiary_assistant(self):
        @tool
        async def beneficiary_assistant(client_id: str, request: str) -> str:
            """Handle a beneficiary-related request (list, add, or delete beneficiaries).

            Args:
                client_id: The customer's client ID.
                request: A natural-language description of what the customer wants done with their beneficiaries.

            Returns:
                The beneficiary agent's response.
            """
            return await self._run_subagent(
                client_id=client_id,
                request=request,
                system_prompt=BENE_INSTRUCTIONS,
                tools=[
                    _activity_tool(Beneficiaries.list_beneficiaries),
                    _activity_tool(Beneficiaries.add_beneficiary),
                    _activity_tool(Beneficiaries.delete_beneficiary),
                ],
                persistent_key="beneficiary",
            )

        return beneficiary_assistant

    def _make_investment_assistant(self):
        @tool
        async def investment_assistant(client_id: str, request: str) -> str:
            """Handle any investment-account request: list, close, or open an account.

            Listing and closing are handled directly; opening a new account is delegated
            onward to the persistent open-account agent (open_account_assistant), which
            drives the durable KYC + compliance flow.

            Args:
                client_id: The customer's client ID.
                request: A natural-language description of what the customer wants done with their investment accounts.

            Returns:
                The investment agent's response.
            """
            return await self._run_subagent(
                client_id=client_id,
                request=request,
                system_prompt=TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS,
                tools=[
                    _activity_tool(Investments.list_investments),
                    _activity_tool(Investments.close_investment),
                    # Nested delegate: the investment agent owns account-opening and
                    # hands it to the dedicated open-account agent.
                    self._make_open_account_assistant(),
                ],
                persistent_key="investment",
            )

        return investment_assistant

    def _make_open_account_assistant(self):
        @tool
        async def open_new_investment_account(client_id: str, account_name: str, initial_amount: float) -> str:
            """Begin opening a new investment account via a durable child workflow.

            Args:
                client_id: The customer's client ID.
                account_name: The name for the new investment account.
                initial_amount: The initial deposit amount.

            Returns:
                The child workflow ID, which the other open-account tools require, or
                the reason the account cannot be opened. Starting the opening does not
                open the account: it still needs KYC and a compliance review.
            """
            # Business rules are checked up front. A violation is a non-retryable error:
            # it fails on the first attempt, and the reason goes back to the agent.
            try:
                await workflow.execute_activity(
                    Investments.validate_new_account,
                    args=[client_id, account_name, initial_amount],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=TOOL_RETRY_POLICY,
                )
            except ActivityError as e:
                # Strands only shows the model str(error), which for an ActivityError is
                # "Activity task failed"; pass the business reason through instead.
                if isinstance(e.__cause__, ApplicationError):
                    return f"The account cannot be opened: {e.__cause__.message}"
                raise

            # Read in an activity so the result is recorded in history and replays the same.
            promo_code = await workflow.execute_activity(
                Investments.find_promotion,
                client_id,
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=TOOL_RETRY_POLICY,
            )
            account_input = OpenInvestmentAccountInput(
                client_id=client_id,
                account_name=account_name,
                initial_amount=initial_amount,
                promo_code=promo_code,
            )
            # Same format as the other frameworks. The number counts the account openings
            # started in this conversation (this one included), so every request to open
            # an account starts a new child workflow with its own KYC, even when an
            # opening with the same name is still running or has finished. It is kept in
            # workflow state, so it replays the same, and counts only openings that
            # were started (not ones refused above).
            opening_number = self._account_openings_started + 1
            child_workflow_id = (
                f"OpenAccount-{workflow.info().workflow_id}-{client_id}-{account_name}-{opening_number}"
            )
            # TERMINATE matches the other frameworks: ending the conversation stops its pending
            # account openings.
            await workflow.start_child_workflow(
                OpenInvestmentAccountWorkflow.run,
                account_input,
                id=child_workflow_id,
                parent_close_policy=ParentClosePolicy.TERMINATE,
                task_queue=OPEN_ACCOUNT_TASK_QUEUE,
            )
            self._account_openings_started = opening_number
            # Known from the start, so a status check right away doesn't report "not found"
            # before the child's first state update arrives.
            self._account_opening_states.setdefault(child_workflow_id, "Initializing")
            self._account_opening_names.setdefault(child_workflow_id, account_name)
            # A bare ID reads like success, and the model told customers their account
            # was open. Say plainly that it is not.
            return (
                f"Account opening started. The account is NOT open yet: the customer must confirm "
                f"their details (KYC), then it needs a compliance review. Workflow ID: {child_workflow_id}"
            )

        @tool
        async def get_account_opening_status(workflow_id: str) -> str:
            """Get the current status of an account opening.

            Args:
                workflow_id: The open-account child workflow ID returned by open_new_investment_account.

            Returns:
                The latest status the account opening reported. "Complete" means the account
                was opened; a status starting with "Rolled back" means it was not opened.
                Either way, that account opening is finished.
            """
            state = self._account_opening_states.get(workflow_id)
            if state is None:
                return f"No account opening with workflow ID {workflow_id} was found in this conversation."
            return state

        @tool
        async def get_current_client_info(workflow_id: str) -> dict:
            """Retrieve the customer's current details for an account opening, to show them for KYC.

            Args:
                workflow_id: The open-account child workflow ID returned by open_new_investment_account.
            """
            client = await workflow.execute_activity(
                OpenAccount.get_current_client_info,
                workflow_id,
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=TOOL_RETRY_POLICY,
            )
            self._kyc_details_shown_turn[workflow_id] = self._turn
            return client

        @tool
        async def approve_kyc(workflow_id: str) -> str:
            """Approve KYC for an account opening, after the customer confirmed their details are correct.

            Args:
                workflow_id: The open-account child workflow ID returned by open_new_investment_account.
            """
            if not kyc_confirmed(self._kyc_details_shown_turn.get(workflow_id), self._turn):
                return KYC_NOT_APPROVED
            await workflow.execute_activity(
                OpenAccount.approve_kyc,
                workflow_id,
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=TOOL_RETRY_POLICY,
            )
            return "KYC approved. The account is now waiting for compliance review."

        @tool
        async def open_account_assistant(client_id: str, request: str) -> str:
            """Open a new investment account (a multi-step, durable KYC + compliance flow).

            This delegates to a persistent open-account agent that drives the durable
            child workflow across several customer turns, so relay whatever the customer
            said (the account name and initial amount, a confirmation that their details
            are correct, or which details to change) and relay the agent's reply back.

            Args:
                client_id: The customer's client ID.
                request: A natural-language description of what the customer wants done
                    with respect to opening the account.

            Returns:
                The open-account agent's response.
            """
            # The agent is persistent, so its history holds whatever status it last
            # saw. Give it the current status on every turn so a finished opening
            # (for example, one that was rolled back) is never reported as pending.
            return await self._run_subagent(
                client_id=client_id,
                request=f"{self._account_openings_summary()}{request}",
                system_prompt=OPEN_ACCOUNT_INSTRUCTIONS,
                tools=[
                    open_new_investment_account,
                    get_account_opening_status,
                    get_current_client_info,
                    approve_kyc,
                    update_client_details,
                ],
                persistent_key="open_account",
            )

        return open_account_assistant

    def _account_openings_summary(self) -> str:
        """The current status of each account opening in this conversation, as a
        sentence to put before the customer's request (empty when there are none)."""
        if not self._account_opening_states:
            return ""
        openings = "; ".join(
            f'{self._account_opening_names[workflow_id]} (workflow ID {workflow_id}): "{state}"'
            for workflow_id, state in self._account_opening_states.items()
        )
        return f"Current status of account openings in this conversation: {openings}. "

    @workflow.run
    async def run(self) -> None:
        self.wf_id = workflow.info().workflow_id

        await workflow.execute_local_activity(
            EventStreamActivities.delete_conversation,
            args=[self.wf_id],
            start_to_close_timeout=self.local_to_close_timeout,
            retry_policy=self.retry_policy,
        )

        # The supervisor is a pure orchestrator: it delegates beneficiary and
        # investment requests to specialized sub-agents (see _make_*_assistant).
        # Opening an account is nested one level deeper — the investment agent
        # owns it and delegates onward to the persistent open-account agent, which
        # drives the durable child workflow. The confirmation guard lives on the sub-agents.
        self._agent = TemporalAgent(
            model=MODEL_NAME,
            task_queue=LLM_TASK_QUEUE,
            start_to_close_timeout=MODEL_TIMEOUT,
            retry_policy=LLM_RETRY_POLICY,
            system_prompt=TEMPORAL_SUPERVISOR_INSTRUCTIONS,
            tools=[
                self._make_beneficiary_assistant(),
                self._make_investment_assistant(),
            ],
        )

        while True:
            await workflow.wait_condition(
                lambda: (
                    not self.pending_chat_messages.empty()
                    or not self.pending_status_updates.empty()
                    or self.end_workflow_flag
                )
            )

            if self.end_workflow_flag:
                return

            while not self.pending_status_updates.empty():
                await self._process_status_update(self.pending_status_updates.get_nowait())

            if not self.pending_chat_messages.empty():
                await self._process_chat_message(self.pending_chat_messages.get_nowait())

            # TODO: Continue-As-New.
            # This demo keeps the whole conversation in one workflow run. A production system
            # would call continue-as-new when workflow.info().is_continue_as_new_suggested()
            # returns true, because Temporal limits a run's event history (warnings at 10K
            # events / 10 MB, terminated at 50K events / 50 MB) and every LLM call and tool
            # call adds events, so a long-running chat would eventually hit those limits.
            # To do it safely:
            #   - Wait for workflow.all_handlers_finished() and drain the pending message and
            #     status queues first, so no customer message or status update is lost.
            #   - Carry the conversation state into the new run: the message history, the
            #     active agent, the client ID, the account-opening states, names, and
            #     count, and the KYC guard's turn tracking.
            #   - Open-account child workflows are started with ParentClosePolicy.TERMINATE,
            #     which also applies when the parent continues-as-new, so an opening waiting
            #     for KYC or compliance would be terminated. Use ParentClosePolicy.ABANDON and
            #     have the end_workflow handler cancel/terminate any openings still running,
            #     or defer continue-as-new until no opening is in progress.

    async def _process_chat_message(self, message: str) -> None:
        self._turn += 1
        chat = ChatInteraction(user_prompt=message, text_response="")

        result = await self._agent.invoke_async(message)
        chat.text_response = str(result).strip()
        self.chat_history.append(chat)

        await workflow.execute_local_activity(
            EventStreamActivities.append_chat_interaction,
            args=[self.wf_id, chat],
            start_to_close_timeout=self.local_to_close_timeout,
            retry_policy=self.retry_policy,
        )

    async def _process_status_update(self, status_message: str) -> None:
        await self._append_status(status_message)

    async def _append_status(self, status_message: str) -> None:
        self.status_updates.append(status_message)
        await workflow.execute_local_activity(
            EventStreamActivities.append_status_update,
            args=[self.wf_id, StatusUpdate(status=status_message)],
            start_to_close_timeout=self.local_to_close_timeout,
            retry_policy=self.retry_policy,
        )

    # ----- Queries -----
    @workflow.query
    def get_chat_history(self) -> List[ChatInteraction]:
        return self.chat_history

    @workflow.query
    def get_status_updates(self) -> List[str]:
        return self.status_updates

    # ----- Signals -----
    @workflow.signal
    async def process_user_message(self, message_input: ProcessUserMessageInput) -> None:
        await self.pending_chat_messages.put(message_input.user_input)

    @workflow.signal
    def end_workflow(self) -> None:
        self.end_workflow_flag = True

    @workflow.signal
    async def update_account_opening_state(self, state_input: UpdateAccountOpeningStateInput) -> None:
        self._account_opening_states[state_input.workflow_id] = state_input.state
        self._account_opening_names[state_input.workflow_id] = state_input.account_name
        # Surface a simple account-opening status. Compliance is approved out-of-band
        # by an employee via the run_send_compliance_approval CLI (using the child
        # workflow ID from the Temporal UI).
        await self.pending_status_updates.put(
            f"New {state_input.account_name} account status changed: {state_input.state}"
        )
