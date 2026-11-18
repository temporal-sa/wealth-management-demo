import asyncio
import logging
import os

from temporalio.client import Client
from temporalio.worker import Worker
from temporalio.google_adk import GoogleAdkPlugin

from common.client_helper import ClientHelper
from common.util import str_to_bool
from common.claim_check.claim_check_plugin import ClaimCheckPlugin
from durable.activities.clients import ClientActivities
from durable.activities.event_stream_activities import EventStreamActivities
from durable.activities.open_account import OpenAccount
from durable.activities.beneficiaries import Beneficiaries
from durable.activities.custodian import Custodian
from durable.activities.funding import Funding
from durable.activities.investments import Investments
from durable.model_config import register_chaos_aware_gemini
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow
from durable.task_queues import DEFAULT_TASK_QUEUE


def choose_workflows(client_helper: ClientHelper) -> list:
    # The Open Account workflow runs here unless it has its own task queue (e.g. the Java worker)
    if client_helper.taskQueue == client_helper.taskQueueOpenAccount:
        return [WealthManagementWorkflow, OpenInvestmentAccountWorkflow]
    return [WealthManagementWorkflow]


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(filename)s:%(lineno)s | %(message)s",
    )

    client_helper = ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE)
    # Without the agents (no chat workflow, no model calls), for the open-account scenarios.
    # SKIP_AGENTS is the monorepo's name; SKIP_ADK_PLUGIN, this port's older one, still works.
    skip_agents = client_helper.skipAgents or str_to_bool(os.getenv("SKIP_ADK_PLUGIN", "False"))
    # Model calls go through ChaosAwareGemini, so the chaos panel can fail them
    register_chaos_aware_gemini()

    plugins = [ ClaimCheckPlugin() ] if skip_agents else \
        [ GoogleAdkPlugin(),
          ClaimCheckPlugin()
        ]

    print(f"address is {client_helper.address} and plugins are {plugins}")

    client = await Client.connect(**client_helper.client_config,
        plugins=plugins
    )

    worker = Worker(
        client,
        task_queue=client_helper.taskQueue,
        workflows=choose_workflows(client_helper),
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
            ClientActivities.add_client,
            ClientActivities.update_client,
            OpenAccount.get_current_client_info,
            OpenAccount.approve_kyc,
            OpenAccount.update_client_details,
            EventStreamActivities.append_chat_interaction,
            EventStreamActivities.append_status_update,
            EventStreamActivities.delete_conversation,
        ],
    )
    print(
        f"Running worker on {client_helper.address}, task queue: {client_helper.taskQueue}"
    )
    if skip_agents:
        await worker.run()
        return

    # Model calls run on their own task queue. The GoogleAdkPlugin registers the model
    # activity on every worker built from the client, so this worker needs nothing else.
    # Setting LLM_MAX_CALLS_PER_SECOND has the Temporal service rate limit model calls
    # across all workers, so they queue up instead of hitting the provider's rate limit.
    max_llm_calls = os.getenv("LLM_MAX_CALLS_PER_SECOND")
    llm_worker = Worker(
        client,
        task_queue=client_helper.taskQueueLLM,
        max_task_queue_activities_per_second=float(max_llm_calls) if max_llm_calls else None,
    )
    print(
        f"Model calls on {client_helper.taskQueueLLM}, "
        f"max calls per second: {max_llm_calls or 'unlimited'}"
    )
    await asyncio.gather(worker.run(), llm_worker.run())


if __name__ == "__main__":
    asyncio.run(main())
