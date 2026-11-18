"""The claim check codec, the codec server, and a workflow running with claim check on.

Redis is replaced by an in-memory stand-in, so no Redis is needed. Requires the Temporal
test server (downloaded automatically on first run). No model key needed.
"""

import base64
import uuid

import pytest
from aiohttp.test_utils import TestClient, TestServer
from google.protobuf import json_format
from temporalio.api.common.v1 import Payload, Payloads
from temporalio.client import Client
from temporalio.converter import DataConverter
from temporalio.worker import Worker

from common.claim_check import CODEC_KEY, ClaimCheckCodec, use_claim_check
from common.client_helper import ClientHelper
from temporal_supervisor.codec_server import build_codec_server
from temporal_supervisor.workflows.open_account_workflow import (
    OpenInvestmentAccountInput,
    OpenInvestmentAccountWorkflow,
)
from tests.test_failure_scenarios import CALLS, FAILURES, STUB_ACTIVITIES

TASK_QUEUE = "test-claim-check"


class FakeRedis:
    """The two calls the codec makes, kept in a dict."""

    def __init__(self):
        self.data: dict[str, bytes] = {}

    async def set(self, key: str, value: bytes):
        self.data[key] = value

    async def get(self, key: str):
        return self.data.get(key)


def _payload(text: str) -> Payload:
    return Payload(metadata={"encoding": b"json/plain"}, data=text.encode())


@pytest.fixture
def redis_store():
    return FakeRedis()


@pytest.fixture
def codec(redis_store):
    return ClaimCheckCodec(redis_client=redis_store)


async def test_encode_stores_the_payload_and_sends_only_its_key(codec, redis_store):
    original = _payload('{"client_id": "123"}')

    [encoded] = await codec.encode([original])

    assert encoded.metadata["encoding"] == b"claim-checked"
    assert encoded.metadata[CODEC_KEY] == b"v1"
    key = encoded.data.decode()
    uuid.UUID(key)
    assert b"123" not in encoded.SerializeToString()
    assert Payload.FromString(redis_store.data[key]) == original
    assert await codec.decode([encoded]) == [original]


async def test_payloads_that_were_not_claim_checked_pass_through(codec):
    plain = _payload('"hello"')
    assert await codec.decode([plain]) == [plain]


async def test_a_missing_claim_check_fails_clearly(codec):
    missing = Payload(metadata={"encoding": b"claim-checked", CODEC_KEY: b"v1"}, data=b"no-such-key")
    with pytest.raises(ValueError, match="no-such-key not found in Redis"):
        await codec.decode([missing])


def test_client_helper_uses_the_codec_only_when_claim_check_is_on(monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    assert not use_claim_check()
    assert "data_converter" not in ClientHelper().client_config

    monkeypatch.setenv("USE_CLAIM_CHECK", "true")
    converter = ClientHelper().client_config["data_converter"]
    assert isinstance(converter.payload_codec, ClaimCheckCodec)


async def test_workflow_history_holds_only_claim_checks(temporal_env, codec, redis_store):
    # A client with claim check on, connected to the same test server.
    config = temporal_env.client.config()
    config["data_converter"] = DataConverter(payload_codec=codec)
    claim_checked = Client(**config)
    CALLS.clear()
    FAILURES.clear()

    async with Worker(claim_checked, task_queue=TASK_QUEUE, workflows=[OpenInvestmentAccountWorkflow],
                      activities=STUB_ACTIVITIES):
        handle = await claim_checked.start_workflow(
            OpenInvestmentAccountWorkflow.run,
            OpenInvestmentAccountInput(client_id="C-1", account_name="Secret", initial_amount=500.0),
            id=f"claim-check-test-{uuid.uuid4()}", task_queue=TASK_QUEUE)
        await handle.signal(OpenInvestmentAccountWorkflow.verify_kyc)
        await handle.signal(OpenInvestmentAccountWorkflow.compliance_approved)
        result = await handle.result()

    assert result.account_created
    assert CALLS == ["get_client", "open_investment#1", "debit:500.0", "register"]

    # Read without the codec, every payload in the history is a claim check, and the
    # account name never appears.
    history = await temporal_env.client.get_workflow_handle(handle.id).fetch_history()
    payloads = _payloads(history.to_json_dict())
    assert payloads
    v1 = base64.b64encode(b"v1").decode()
    assert all(p["metadata"].get(CODEC_KEY) == v1 for p in payloads)
    assert b"Secret" not in history.to_json().encode()
    assert any(b"Secret" in value for value in redis_store.data.values())


def _payloads(history_json: dict) -> list[dict]:
    """Every payload in a history's JSON: a dict with metadata that names an encoding."""
    found = []

    def walk(value):
        if isinstance(value, dict):
            if "encoding" in value.get("metadata", {}):
                found.append(value)
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
    walk(history_json)
    return found


async def test_codec_server_decodes_for_the_temporal_ui(codec):
    [encoded] = await codec.encode([_payload('{"account_name": "Vacation"}')])
    body = json_format.MessageToJson(Payloads(payloads=[encoded]))

    async with TestClient(TestServer(build_codec_server(codec))) as client:
        resp = await client.post("/decode", data=body, headers={
            "Content-Type": "application/json", "Origin": "http://localhost:8233"})
        assert resp.status == 200
        assert resp.headers["Access-Control-Allow-Origin"] == "http://localhost:8233"
        decoded = json_format.Parse(await resp.text(), Payloads())
        assert decoded.payloads[0].data == b'{"account_name": "Vacation"}'

        # Other origins get no CORS headers, so a browser won't let them read the result.
        resp = await client.post("/decode", data=body, headers={
            "Content-Type": "application/json", "Origin": "https://example.com"})
        assert "Access-Control-Allow-Origin" not in resp.headers

        resp = await client.options("/decode", headers={"Origin": "https://cloud.temporal.io"})
        assert resp.status == 204
        assert resp.headers["Access-Control-Allow-Origin"] == "https://cloud.temporal.io"


def test_startup_message_says_whether_claim_check_is_on(monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    assert ClientHelper().claim_check_status() == "Claim check: off"

    monkeypatch.setenv("USE_CLAIM_CHECK", "true")
    monkeypatch.setenv("REDIS_HOST", "redis.example")
    monkeypatch.setenv("REDIS_PORT", "6380")
    assert ClientHelper().claim_check_status() == (
        "Claim check: ON (payloads stored in Redis at redis.example:6380)")
