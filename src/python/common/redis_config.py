"""
Shared Redis configuration.

Where Redis is, from the environment. REDIS_URL (redis://:<password>@<host>:<port>/<db>)
wins when it is set; otherwise REDIS_HOST, REDIS_PORT and the optional REDIS_PASSWORD are
used. Locally nothing needs to be set: the default is an unauthenticated Redis on
localhost:6379.

Example:
    config = RedisConfig()
    client = config.async_client()
"""

import os
import logging
from dataclasses import dataclass
from typing import Optional

import redis
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


@dataclass
class RedisConfig:
    """Configuration for the Redis connection, loaded from the environment."""

    hostname: str = "localhost"
    port: int = 6379
    password: Optional[str] = None
    url: Optional[str] = None

    def __post_init__(self):
        self.hostname = os.getenv("REDIS_HOST", self.hostname)
        self.port = int(os.getenv("REDIS_PORT", self.port))
        self.password = os.getenv("REDIS_PASSWORD") or self.password
        self.url = os.getenv("REDIS_URL") or self.url

    def address(self) -> str:
        """Where Redis is, for startup messages (never includes the password)."""
        if self.url:
            pool = aioredis.ConnectionPool.from_url(self.url)
            kwargs = pool.connection_kwargs
            return f"{kwargs.get('host', 'localhost')}:{kwargs.get('port', 6379)}"
        return f"{self.hostname}:{self.port}"

    def async_client(self, decode_responses: bool = True) -> aioredis.Redis:
        if self.url:
            return aioredis.Redis.from_url(self.url, decode_responses=decode_responses)
        return aioredis.Redis(
            host=self.hostname, port=self.port, password=self.password, decode_responses=decode_responses
        )

    def sync_client(self, decode_responses: bool = True) -> redis.Redis:
        if self.url:
            return redis.Redis.from_url(self.url, decode_responses=decode_responses)
        return redis.Redis(
            host=self.hostname, port=self.port, password=self.password, decode_responses=decode_responses
        )
