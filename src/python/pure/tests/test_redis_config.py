"""The shared RedisConfig (common/redis_config.py): host, port, password or URL from the environment."""
from common.redis_config import RedisConfig


def _clear(monkeypatch):
    for name in ("REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "REDIS_URL"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_to_local_redis_without_a_password(monkeypatch):
    _clear(monkeypatch)
    kwargs = RedisConfig().async_client().connection_pool.connection_kwargs
    assert (kwargs["host"], kwargs["port"], kwargs.get("password")) == ("localhost", 6379, None)


def test_reads_host_port_and_password(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("REDIS_HOST", "cache.example")
    monkeypatch.setenv("REDIS_PORT", "6380")
    monkeypatch.setenv("REDIS_PASSWORD", "s3cret")
    for client in (RedisConfig().async_client(), RedisConfig().sync_client()):
        kwargs = client.connection_pool.connection_kwargs
        assert (kwargs["host"], kwargs["port"], kwargs["password"]) == ("cache.example", 6380, "s3cret")


def test_url_wins_over_host_and_port(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("REDIS_HOST", "ignored.example")
    monkeypatch.setenv("REDIS_URL", "redis://:s3cret@cache.example:6390/2")
    config = RedisConfig()
    kwargs = config.async_client().connection_pool.connection_kwargs
    assert (kwargs["host"], kwargs["port"], kwargs["password"], kwargs["db"]) == ("cache.example", 6390, "s3cret", 2)
    assert config.address() == "cache.example:6390"


def test_claim_check_codec_keeps_payload_bytes(monkeypatch):
    _clear(monkeypatch)
    # The codec stores raw payload bytes, so its client must not decode responses to str
    from common.claim_check.claim_check_codec import ClaimCheckCodec
    codec = ClaimCheckCodec(RedisConfig())
    assert codec.redis_client.connection_pool.connection_kwargs.get("decode_responses") is False
