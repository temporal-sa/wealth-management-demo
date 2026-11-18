import pytest
from temporalio.testing import WorkflowEnvironment

import temporal_supervisor.chaos as chaos
from common.chaos_manager import ChaosFlag


@pytest.fixture(scope="module")
async def temporal_env():
    """Temporal's local test server (downloaded automatically on first run)."""
    async with await WorkflowEnvironment.start_local() as env:
        yield env


@pytest.fixture
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
