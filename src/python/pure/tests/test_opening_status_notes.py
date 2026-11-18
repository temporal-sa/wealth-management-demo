"""Every agent is told the account openings started in the conversation and their current states.

The states arrive as update_account_opening_state signals, not in the conversation, so
without this note an agent that didn't start the opening (such as the Investment Agent
listing accounts) has to guess where each one stands.

No model key, Redis or Temporal service needed.
"""

from common.agent_loop import Agent
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementContext

AGENT = Agent(name="Investment Agent", handoff_description="", instructions="Instructions.")


def test_no_note_before_any_opening():
    context = WealthManagementContext(client_id="123")
    assert AGENT.system_prompt(context) == (
        "Instructions.\n    The customer's client ID is 123. Use it, and don't ask for it again.")


def test_each_opening_is_listed_with_its_request_and_current_state():
    first, second = "OpenAccount-chat-123-Vacation-1", "OpenAccount-chat-123-Vacation-2"
    context = WealthManagementContext(client_id="123")
    context.account_opening_requests = {first: "Vacation with $13,500.00", second: "Vacation with $13,500.00"}
    context.account_opening_states = {
        first: "Rolled back. The account was not opened: The custodian rejected the account registration.",
    }

    prompt = AGENT.system_prompt(context)

    assert "The customer's client ID is 123." in prompt
    assert (f"- Vacation with $13,500.00 (workflow ID {first}): Rolled back. The account was not opened: "
            "The custodian rejected the account registration.") in prompt
    # No state reported yet.
    assert f"- Vacation with $13,500.00 (workflow ID {second}): Initializing" in prompt
    assert prompt.index(first) < prompt.index(second)

    context.account_opening_states[second] = "Complete"
    assert f"(workflow ID {second}): Complete" in AGENT.system_prompt(context)
