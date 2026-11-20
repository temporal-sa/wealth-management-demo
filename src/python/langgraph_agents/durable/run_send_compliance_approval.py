import argparse
import asyncio
import logging

from durable import connection
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow


async def approve(workflow_id: str):
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s | %(levelname)s | %(filename)s:%(lineno)s | %(message)s")

    client_helper = connection.client_helper()
    print(f"address is {client_helper.address}")
    print(connection.claim_check_status())
    client = await connection.connect(client_helper)

    handle = client.get_workflow_handle(workflow_id=workflow_id)
    await handle.signal(OpenInvestmentAccountWorkflow.compliance_approved)
    print(f"Sent compliance approval to {workflow_id}")

async def main():
    parser = argparse.ArgumentParser(
        description="",
        epilog="Example usage:\n"
               "  python run_send_compliance_approval.py --workflow-id myworkflow\n"
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