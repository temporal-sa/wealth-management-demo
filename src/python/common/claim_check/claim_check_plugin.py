import os

from temporalio.client import Plugin, ClientConfig
from temporalio.converter import DataConverter

from common.redis_config import RedisConfig
from common.util import str_to_bool
from common.claim_check.claim_check_codec import ClaimCheckCodec

class ClaimCheckPlugin(Plugin):
    def __init__(self):
        self.useClaimCheck = str_to_bool(os.getenv("USE_CLAIM_CHECK", "False"))

        # Redis configuration
        self.redis_config = RedisConfig()

    def get_data_converter(self, config: ClientConfig) -> DataConverter:
        default_converter_class = config["data_converter"].payload_converter_class
        if self.useClaimCheck:
            print(f"using claim check codec {self.useClaimCheck}")
            claim_check_codec = ClaimCheckCodec(self.redis_config)

            return DataConverter(
                payload_converter_class=default_converter_class,
                payload_codec=claim_check_codec
            )
        else:
            return DataConverter(
                payload_converter_class=default_converter_class
            )

    # Works with both Temporal Python SDK plugin interfaces: 1.18 chains plugins through
    # init_client_plugin and self.next_plugin (the OpenAI Agents port); 1.19 and later call
    # each plugin's configure_client in turn and pass `next` to connect_service_client
    # (the Pydantic AI port).

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
