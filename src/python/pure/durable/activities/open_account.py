from typing import Any

from temporalio import activity
from temporalio.client import Client


class OpenAccount:
    """The chat side of an account opening: talks to the open-account child workflow.

    The chat workflow can't send an update to another workflow itself, so these run as
    activities, with the worker's Temporal client.
    """

    def __init__(self, client: Client):
        self._client = client

    def _handle(self, workflow_id: str):
        return self._client.get_workflow_handle(workflow_id)

    @activity.defn
    async def get_current_client_info(self, workflow_id: str) -> Any:
        """The customer's details held by the account opening, via its get_client_details update."""
        return await self._handle(workflow_id).execute_update("get_client_details")

    @activity.defn
    async def approve_kyc(self, workflow_id: str) -> None:
        """Tell the account opening that the customer confirmed their details."""
        await self._handle(workflow_id).signal("verify_kyc")

    @activity.defn
    async def update_client_details(self, workflow_id: str, client_details: dict) -> str:
        """Save changed customer details through the account opening, which completes KYC.

        Only the fields that are set are changed.
        """
        changed = {k: v for k, v in client_details.items() if v is not None and k != "client_id"}
        return await self._handle(workflow_id).execute_update("update_client_details", args=[changed])
