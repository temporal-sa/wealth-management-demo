import argparse
import asyncio
import logging

from temporalio.client import Client
from common.client_helper import ClientHelper
from durable.task_queues import DEFAULT_TASK_QUEUE

from common.claim_check.claim_check_plugin import ClaimCheckPlugin
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow


async def approve(workflow_id: str):
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s | %(levelname)s | %(filename)s:%(lineno)s | %(message)s")

    client_helper = ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE)
    print(f"address is {client_helper.address}")
    client = await Client.connect(**client_helper.client_config,
                                  plugins=[
                                      # OpenAIAgentsPlugin(),
                                      ClaimCheckPlugin()
                                  ])

    handle = client.get_workflow_handle(workflow_id=workflow_id)
    await handle.signal(OpenInvestmentAccountWorkflow.compliance_approved)

async def main():
    parser = argparse.ArgumentParser(
        description="",
        epilog='Example usage:\n'
               '  cd src/python/pyai/durable && ./localsendcomplianceapproval.sh myworkflow\n'
    )

    # Global argument for Workflow ID
    parser.add_argument(
        '--workflow-id',
        type=str,
        required=True,
        help='The ID of the workflow to send the approval to'
    )

    args = parser.parse_args()
    await approve(args.workflow_id)

if __name__ == "__main__":
    asyncio.run(main())