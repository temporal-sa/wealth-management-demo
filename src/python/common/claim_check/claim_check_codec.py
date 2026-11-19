"""Claim-check payload codec.

Replaces every payload sent to Temporal with a random ID and stores the original
payload (the serialized ``Payload`` protobuf) in Redis under that ID. Decoding
looks the ID up again. Payloads that were not claim-checked pass through
unchanged, so histories written without the codec stay readable.

The metadata and storage format match the Java worker's ``ClaimCheckCodec``
(interop/open_account/java/src/main/java/io/temporal/demo/wealthmanagement/claimcheck), so either
side can decode the other's payloads.

Stored payloads expire after CLAIM_CHECK_TTL_SECONDS (default 7 days; 0 keeps them forever), so
they don't pile up in Redis. A workflow needs its payloads to replay, and the Temporal UI needs
them to show its history, so keep the expiry well beyond how long a workflow runs.
"""

import os
import uuid
from typing import Any, Iterable, List, Optional

from temporalio.api.common.v1 import Payload
from temporalio.converter import PayloadCodec

from common.redis_config import RedisConfig

ENCODING = b"claim-checked"
CODEC_KEY = "temporal.io/claim-check-codec"
CODEC_VERSION = b"v1"

DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60


def claim_check_ttl_seconds() -> Optional[int]:
    """How long stored payloads are kept (CLAIM_CHECK_TTL_SECONDS); None keeps them forever."""
    value = os.getenv("CLAIM_CHECK_TTL_SECONDS", "").strip()
    seconds = int(value) if value else DEFAULT_TTL_SECONDS
    return seconds if seconds > 0 else None


class ClaimCheckCodec(PayloadCodec):
    def __init__(self, config: Optional[RedisConfig] = None, redis_client: Any = None):
        """Store payloads in the Redis at ``config`` (REDIS_URL, or REDIS_HOST / REDIS_PORT / REDIS_PASSWORD).

        ``redis_client`` replaces the Redis connection with any object that has
        async ``get(key)`` and ``set(key, value, ex=seconds)`` methods (used by the tests).
        """
        self.ttl_seconds = claim_check_ttl_seconds()
        if redis_client is None:
            config = config or RedisConfig()
            redis_client = config.async_client(decode_responses=False)
        self.redis_client = redis_client

    async def encode(self, payloads: Iterable[Payload]) -> List[Payload]:
        return [await self._encode_payload(p) for p in payloads]

    async def decode(self, payloads: Iterable[Payload]) -> List[Payload]:
        return [await self._decode_payload(p) for p in payloads]

    async def _encode_payload(self, payload: Payload) -> Payload:
        claim_id = str(uuid.uuid4())
        await self.redis_client.set(claim_id, payload.SerializeToString(), ex=self.ttl_seconds)
        return Payload(
            metadata={"encoding": ENCODING, CODEC_KEY: CODEC_VERSION},
            data=claim_id.encode("utf-8"),
        )

    async def _decode_payload(self, payload: Payload) -> Payload:
        if payload.metadata.get(CODEC_KEY) != CODEC_VERSION:
            return payload
        claim_id = payload.data.decode("utf-8")
        value = await self.redis_client.get(claim_id)
        if value is None:
            raise ValueError(f"Claim-checked payload {claim_id} not found in Redis")
        return Payload.FromString(value)
