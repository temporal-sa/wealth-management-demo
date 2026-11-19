import asyncio
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
from temporalio.worker import Worker

from durable.client_helper import connect_client
from durable.model_config import (
    LLM_MAX_CALLS_PER_SECOND,
    LLM_TASK_QUEUE,
    OPEN_ACCOUNT_TASK_QUEUE,
    TASK_QUEUE,
)
from durable.activities.beneficiaries import Beneficiaries
from durable.activities.investments import Investments
from durable.activities.clients import ClientActivities
from durable.activities.custodian import Custodian
from durable.activities.funding import Funding
from durable.activities.open_account import OpenAccount
from durable.activities.event_stream_activities import EventStreamActivities
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow

load_dotenv()


def choose_workflows(task_queue: str = TASK_QUEUE, open_account_task_queue: str = OPEN_ACCOUNT_TASK_QUEUE) -> list:
    """The workflows this worker runs on the main task queue.

    When the open-account child workflow has its own task queue (the first argument
    to startlocalworker.sh / startcloudworker.sh, e.g. for the Java worker), this
    worker leaves OpenInvestmentAccountWorkflow to the worker polling that queue.
    It still registers every activity, so that workflow can call them by name on
    the main task queue.
    """
    if open_account_task_queue == task_queue:
        return [WealthManagementWorkflow, OpenInvestmentAccountWorkflow]
    return [WealthManagementWorkflow]


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(filename)s:%(lineno)s | %(message)s",
    )

    client = await connect_client()

    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=choose_workflows(),
        activities=[
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
            ClientActivities.update_client,
            OpenAccount.get_current_client_info,
            OpenAccount.approve_kyc,
            OpenAccount.update_client_details,
            EventStreamActivities.append_chat_interaction,
            EventStreamActivities.append_status_update,
            EventStreamActivities.delete_conversation,
        ],
    )
    # Model calls run on their own task queue so they can be rate limited without
    # slowing down the tools. The StrandsPlugin on the client registers the model
    # activities on every worker, so this one needs nothing else. The limit is
    # enforced by the Temporal service across all workers polling the queue.
    llm_worker = Worker(
        client,
        task_queue=LLM_TASK_QUEUE,
        max_task_queue_activities_per_second=LLM_MAX_CALLS_PER_SECOND,
    )
    limit = f"{LLM_MAX_CALLS_PER_SECOND}/s" if LLM_MAX_CALLS_PER_SECOND else "unlimited"
    print(f"Worker running on task queues '{TASK_QUEUE}' and '{LLM_TASK_QUEUE}' (model calls: {limit}). Ctrl+C to exit.")
    if OPEN_ACCOUNT_TASK_QUEUE != TASK_QUEUE:
        print(
            f"Open-account child workflows run on '{OPEN_ACCOUNT_TASK_QUEUE}', not on this worker; "
            f"start the worker that polls it (e.g. TEMPORAL_TASK_QUEUE={TASK_QUEUE} interop/open_account/java/startlocalworker.sh)."
        )
    await asyncio.gather(worker.run(), llm_worker.run())


if __name__ == "__main__":
    asyncio.run(main())
