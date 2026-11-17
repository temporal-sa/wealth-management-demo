import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv

from durable.client_helper import connect_client
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow

load_dotenv()


async def approve(workflow_id: str):
    client = await connect_client()
    handle = client.get_workflow_handle_for(OpenInvestmentAccountWorkflow.run, workflow_id)
    await handle.signal(OpenInvestmentAccountWorkflow.compliance_approved)
    print(f"Sent compliance approval to child workflow: {workflow_id}")


def main():
    parser = argparse.ArgumentParser(
        description="Send the compliance-approved signal to an open-account child workflow.",
        epilog="Example: cd src/python/strands_agents/durable && ./localsendcomplianceapproval.sh OpenAccount-...",
    )
    parser.add_argument("--workflow-id", type=str, required=True, help="The open-account child workflow ID")
    args = parser.parse_args()
    asyncio.run(approve(args.workflow_id))


if __name__ == "__main__":
    main()
