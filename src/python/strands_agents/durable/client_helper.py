"""Connects a Temporal client with the StrandsPlugin attached.

The plugin must be on the *client* (not just the worker) so that the plugin's
failure converter is installed — this is what lets activity-tool interrupts and
structured output cross the activity boundary. Workers built from this client
inherit the plugin automatically.

With USE_CLAIM_CHECK=true the client also gets the ClaimCheckPlugin, which adds
the claim-check codec (payloads stored in Redis) to the StrandsPlugin's data
converter. Every Temporal client in the project (worker, API, CLI chat,
compliance-approval and open-account scripts, and the open-account activities)
is built here, so they all encode payloads the same way.
"""

import asyncio

from temporalio.client import Client
from temporalio.envconfig import ClientConfig
from temporalio.contrib.strands import StrandsPlugin

from common.claim_check.claim_check_plugin import ClaimCheckPlugin, use_claim_check
from durable.model_config import MODELS


def _connect_config() -> dict:
    """Client.connect's settings from Temporal's environment configuration (TEMPORAL_ADDRESS,
    TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, TEMPORAL_TLS*, or a temporal.toml profile), defaulting
    to a local server. Temporal Cloud works with an API key or an mTLS certificate and key."""
    config = ClientConfig.load_client_connect_config()
    if not config.get("target_host"):
        config["target_host"] = "localhost:7233"
    if not config.get("namespace"):
        config["namespace"] = "default"
    return config


def client_plugins() -> list:
    """The client plugins: StrandsPlugin, then ClaimCheckPlugin if USE_CLAIM_CHECK=true.

    The order matters: the claim-check plugin adds its codec to the data
    converter the StrandsPlugin has set up.
    """
    plugins = [StrandsPlugin(models=MODELS)]
    if use_claim_check():
        plugins.append(ClaimCheckPlugin())
    return plugins


async def connect_client(max_attempts: int = 5) -> Client:
    connect_config = _connect_config()
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await Client.connect(**connect_config, plugins=client_plugins())
        except RuntimeError as exc:
            # Tolerate transient transport resets during startup.
            last_exc = exc
            if attempt < max_attempts:
                await asyncio.sleep(0.5 * attempt)
    raise last_exc  # type: ignore[misc]
