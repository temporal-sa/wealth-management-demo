"""Browser sessions (common/session_scope.py) and what they scope: the sample data
(common/data_store.py, with DEMO_DATA_STORE=redis) and the chaos flags (common/chaos_manager.py).
Redis is replaced by an in-memory fake, so no Redis is needed."""
import json
import dataclasses

import pytest

from common import data_store
from common.beneficiaries_manager import BeneficiariesManager
from common.chaos_manager import ChaosFlag, ChaosManager
from common.funding_manager import FundingManager
from common.investment_manager import InvestmentManager
from common.session_scope import (
    DEFAULT_SESSION,
    chat_workflow_prefix,
    new_chat_workflow_id,
    new_session_id,
    owns_workflow,
    session_from_workflow_id,
)

PREFIX = "adk-go-temporal-agent-"


class FakeRedis:
    """The calls the data store and the chaos manager make, with expiries."""

    def __init__(self):
        self.values, self.hashes, self.lists, self.expiry = {}, {}, {}, {}

    # data store (sync)
    def get(self, key):
        return self.values.get(key)

    def set(self, key, value, ex=None):
        self.values[key] = value
        self.expiry[key] = ex

    # chaos manager (async)
    async def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    async def hset(self, key, field, value):
        self.hashes.setdefault(key, {})[field] = value

    async def hdel(self, key, field):
        self.hashes.get(key, {}).pop(field, None)

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    async def expire(self, key, seconds):
        self.expiry[key] = seconds

    async def lpush(self, key, value):
        self.lists.setdefault(key, []).insert(0, value)

    async def ltrim(self, key, start, end):
        self.lists[key] = self.lists.get(key, [])[start:end + 1]

    async def lrange(self, key, start, end):
        return self.lists.get(key, [])[start:end + 1]

    async def delete(self, key):
        self.lists.pop(key, None)


def test_chat_workflow_ids_carry_the_session():
    session = new_session_id()
    chat = new_chat_workflow_id(PREFIX, session)
    assert chat.startswith(f"{PREFIX}session-{session}-chat-")
    assert owns_workflow(PREFIX, session, chat)
    assert not owns_workflow(PREFIX, new_session_id(), chat)
    assert not owns_workflow(PREFIX, session, chat_workflow_prefix(PREFIX, session))
    assert not owns_workflow(PREFIX, session, "oai-temporal-agent-k3j9x2m1q8")


def test_the_session_comes_from_a_chat_or_account_opening_id():
    session = new_session_id()
    chat = new_chat_workflow_id(PREFIX, session)
    assert session_from_workflow_id(chat) == session
    assert session_from_workflow_id(f"OpenAccount-{chat}-123-Vacation account-1") == session
    for other in ("oai-temporal-agent-k3j9x2m1q8", "testing-open-account-1", "", None):
        assert session_from_workflow_id(other) == DEFAULT_SESSION


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(data_store, "_shared_redis", lambda: fake)
    return fake


@pytest.fixture
def data_dir(tmp_path):
    files = {
        "beneficiaries.json": {"123": [{"beneficiary_id": "b-1", "first_name": "John", "last_name": "Doe",
                                        "relationship": "son"}]},
        "investments.json": {"123": [{"investment_id": "i-1", "name": "Checking", "balance": 1000.0}]},
        "funding_accounts.json": {"accounts": {"123": {"balance": 10000.0}}, "transfers": {}},
    }
    for name, content in files.items():
        (tmp_path / name).write_text(json.dumps(content))
    return tmp_path


def test_file_store_is_the_default_and_writes_the_files(monkeypatch, redis, data_dir):
    monkeypatch.delenv("DEMO_DATA_STORE", raising=False)
    BeneficiariesManager(str(data_dir / "beneficiaries.json")).add_beneficiary("123", "Jane", "Doe", "daughter")
    on_disk = json.loads((data_dir / "beneficiaries.json").read_text())
    assert [b["first_name"] for b in on_disk["123"]] == ["John", "Jane"]
    assert redis.values == {}


def test_redis_store_gives_each_session_its_own_copy(monkeypatch, redis, data_dir):
    monkeypatch.setenv("DEMO_DATA_STORE", "redis")
    alice, bob = new_session_id(), new_session_id()
    path = str(data_dir / "beneficiaries.json")

    monkeypatch.setattr(data_store, "current_session", lambda: alice)
    BeneficiariesManager(path).add_beneficiary("123", "Jane", "Doe", "daughter")
    assert [b["first_name"] for b in BeneficiariesManager(path).list_beneficiaries("123")] == ["John", "Jane"]

    monkeypatch.setattr(data_store, "current_session", lambda: bob)
    assert [b["first_name"] for b in BeneficiariesManager(path).list_beneficiaries("123")] == ["John"]

    # The file is untouched, and alice's copy expires a day after its last change
    assert [b["first_name"] for b in json.loads((data_dir / "beneficiaries.json").read_text())["123"]] == ["John"]
    assert redis.expiry[f"data:{alice}:beneficiaries"] == 24 * 60 * 60


def test_redis_store_covers_investments_and_funding(monkeypatch, redis, data_dir):
    monkeypatch.setenv("DEMO_DATA_STORE", "redis")
    session = new_session_id()
    monkeypatch.setattr(data_store, "current_session", lambda: session)

    FundingManager(str(data_dir / "funding_accounts.json")).debit("123", 500.0, "t-1")
    assert set(redis.values) == {f"data:{session}:funding_accounts"}
    assert json.loads((data_dir / "funding_accounts.json").read_text())["accounts"]["123"]["balance"] == 10000.0

    manager = InvestmentManager(str(data_dir / "investments.json"))
    manager.data["123"].append({"investment_id": "i-2", "name": "Vacation", "balance": 500.0})
    manager._save_data()
    names = [a["name"] for a in InvestmentManager(str(data_dir / "investments.json")).data["123"]]
    assert names == ["Checking", "Vacation"]


async def test_chaos_flags_and_events_are_per_session():
    fake = FakeRedis()
    alice, bob = ChaosManager(session_id=new_session_id()), ChaosManager(session_id=new_session_id())
    for manager in (alice, bob):
        manager.redis_client = fake

    await alice.set_enabled(ChaosFlag.TOOL_DOWN, True)
    await alice.record_event(ChaosFlag.TOOL_DOWN, "get_client", 1, "wf-1")

    assert await alice.is_enabled(ChaosFlag.TOOL_DOWN)
    assert not await bob.is_enabled(ChaosFlag.TOOL_DOWN)
    assert (await alice.get_flags())["tool_down"] and not (await bob.get_flags())["tool_down"]
    assert len(await alice.get_events()) == 1 and await bob.get_events() == []
    assert fake.expiry[f"chaos:{alice._session_id}:flags"] == 24 * 60 * 60


async def test_outside_an_activity_chaos_uses_the_default_session():
    fake = FakeRedis()
    manager = ChaosManager()
    manager.redis_client = fake
    await manager.set_enabled(ChaosFlag.LLM_DOWN, True)
    assert "chaos:default:flags" in fake.hashes


async def test_an_activity_finds_its_session_from_its_workflow_id():
    from temporalio import activity
    from temporalio.testing import ActivityEnvironment
    from common.session_scope import current_session

    @activity.defn
    async def which_session() -> str:
        return current_session()

    session = new_session_id()
    env = ActivityEnvironment()
    chat = new_chat_workflow_id(PREFIX, session)
    env.info = dataclasses.replace(env.info, workflow_id=f"OpenAccount-{chat}-123-Vacation-1")
    assert await env.run(which_session) == session
    assert current_session() == DEFAULT_SESSION
