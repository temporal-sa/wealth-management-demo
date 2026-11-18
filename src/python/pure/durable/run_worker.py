"""The worker: runs the chat and open-account workflows, their activities, and the model calls.

Two workers share one client:

* the chat task queue (TEMPORAL_TASK_QUEUE, default Supervisor) runs the workflows and
  the tool activities;
* the model task queue (<TEMPORAL_TASK_QUEUE>-llm, or TEMPORAL_TASK_QUEUE_LLM) runs
  invoke_model. LLM_MAX_CALLS_PER_SECOND has the Temporal service rate limit model calls
  across all workers, so they queue up instead of hitting the provider's rate limit.

If TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT names another queue, the open-account workflow is
left to the worker polling that queue (such as the Java one) and isn't registered here.
"""

import asyncio
import logging
import os

from temporalio.client import Client
from temporalio.worker import Worker

from common.client_helper import ClientHelper
from common.llm_config import llm_model
from temporal_supervisor.activities.beneficiaries import Beneficiaries
from temporal_supervisor.activities.clients import ClientActivities
from temporal_supervisor.activities.custodian import Custodian
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities
from temporal_supervisor.activities.funding import Funding
from temporal_supervisor.activities.investments import Investments
from temporal_supervisor.activities.model import invoke_model
from temporal_supervisor.activities.open_account import OpenAccount
from temporal_supervisor.workflows.open_account_workflow import OpenInvestmentAccountWorkflow
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow


def tool_activities(client: Client) -> list:
    """Every activity except the model call, registered under the names the workflows use."""
    event_stream = EventStreamActivities()
    open_account = OpenAccount(client)
    return [
        Beneficiaries.list_beneficiaries,
        Beneficiaries.add_beneficiary,
        Beneficiaries.delete_beneficiary,
        Investments.list_investments,
        Investments.validate_new_account,
        Investments.find_promotion,
        Investments.open_investment,
        Investments.remove_investment,
        Investments.close_investment,
        Funding.debit_linked_account,
        Funding.credit_linked_account,
        Custodian.register_account,
        ClientActivities.get_client,
        ClientActivities.add_client,
        ClientActivities.update_client,
        open_account.get_current_client_info,
        open_account.update_client_details,
        open_account.approve_kyc,
        event_stream.append_chat_interaction,
        event_stream.append_status_update,
        event_stream.delete_conversation,
    ]


async def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s | %(levelname)s | %(filename)s:%(lineno)s | %(message)s")

    client_helper = ClientHelper()
    client = await Client.connect(**client_helper.client_config)

    workflows = [WealthManagementWorkflow]
    if client_helper.taskQueueOpenAccount == client_helper.taskQueue:
        workflows.append(OpenInvestmentAccountWorkflow)
    else:
        print(f"The open-account workflow runs on task queue {client_helper.taskQueueOpenAccount}: "
              "start the worker that polls it.")

    worker = Worker(client, task_queue=client_helper.taskQueue, workflows=workflows,
                    activities=tool_activities(client))

    max_llm_calls = os.getenv("LLM_MAX_CALLS_PER_SECOND")
    llm_worker = Worker(client, task_queue=client_helper.taskQueueLLM, activities=[invoke_model],
                        max_task_queue_activities_per_second=float(max_llm_calls) if max_llm_calls else None)

    print(f"Worker connected to {client_helper.address}. Chat and tools on {client_helper.taskQueue}; "
          f"model calls ({llm_model()}) on {client_helper.taskQueueLLM}, "
          f"max calls per second: {max_llm_calls or 'unlimited'}")
    print(client_helper.claim_check_status())
    await asyncio.gather(worker.run(), llm_worker.run())


if __name__ == '__main__':
    asyncio.run(main())
