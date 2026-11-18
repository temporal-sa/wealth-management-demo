"""Temporal client plugin that adds the claim-check codec to the client's data converter.

It keeps the rest of the data converter as it is (payload converter, failure converter),
so list it *after* a framework plugin that sets one up, such as the StrandsPlugin, whose
failure converter carries agent interrupts across the activity boundary. Plugins
configure the client in list order.

With no codec given, the plugin adds the codec only when USE_CLAIM_CHECK is on, so a
port can always register it. With a codec given, it always adds that codec.

Works with both Temporal Python SDK client plugin interfaces: 1.18 chains plugins through
init_client_plugin and self.next_plugin (the OpenAI Agents port); 1.19 and later call each
plugin's configure_client in turn and pass `next` to connect_service_client (the Pydantic
AI and Strands Agents ports).
"""

import dataclasses
import os
from typing import Optional

from temporalio.client import Plugin, ClientConfig
from temporalio.converter import DataConverter

from common.claim_check.claim_check_codec import ClaimCheckCodec


def use_claim_check() -> bool:
    """Whether USE_CLAIM_CHECK is on (true / 1 / yes / on, in any case), like the Java worker."""
    return os.getenv("USE_CLAIM_CHECK", "false").strip().lower() in ("true", "1", "yes", "on")


class ClaimCheckPlugin(Plugin):
    def __init__(self, codec: Optional[ClaimCheckCodec] = None):
        self.codec = codec
        self.useClaimCheck = codec is not None or use_claim_check()

    def get_data_converter(self, config: ClientConfig) -> DataConverter:
        converter = config.get("data_converter") or DataConverter.default
        if not self.useClaimCheck:
            return converter
        if self.codec is None:
            print("using claim check codec")
            self.codec = ClaimCheckCodec()
        return dataclasses.replace(converter, payload_codec=self.codec)

    def init_client_plugin(self, next: Plugin) -> None:
        """Initialize the plugin chain (SDK 1.18)"""
        self.next_plugin = next

    def configure_client(self, config: ClientConfig) -> ClientConfig:
        config["data_converter"] = self.get_data_converter(config)
        next_plugin = getattr(self, "next_plugin", None)
        return next_plugin.configure_client(config) if next_plugin else config

    async def connect_service_client(self, config, next=None):
        """Pass through to the next plugin in the chain"""
        if next is not None:
            return await next(config)
        return await self.next_plugin.connect_service_client(config)
