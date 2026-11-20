import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment

import durable.chaos as chaos
from common.chaos_manager import ChaosFlag
from tests.scripted_model import use_script


@pytest.fixture(scope="module")
async def temporal_env():
    """Temporal's local test server (downloaded automatically on first run), with the Pydantic
    data converter the worker and the shared API use (durable/connection.py)."""
    async with await WorkflowEnvironment.start_local(data_converter=pydantic_data_converter) as env:
        yield env


@pytest.fixture(autouse=True)
def chaos_flags(monkeypatch):
    """Chaos flags without Redis: all off, until a test adds flags to the returned set."""
    enabled = set()

    async def is_enabled(flag: ChaosFlag) -> bool:
        return flag in enabled

    async def record_event(flag: ChaosFlag) -> None:
        pass

    monkeypatch.setattr(chaos, "is_enabled", is_enabled)
    monkeypatch.setattr(chaos, "record_event", record_event)
    return enabled


@pytest.fixture(autouse=True)
def scripted(monkeypatch):
    """Every agent node's model call replays tests.scripted_model.SCRIPT instead of calling Gemini."""
    use_script(monkeypatch)
