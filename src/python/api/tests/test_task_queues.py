"""The open-account workflow's task queue (common/task_queues.py), which every Python framework uses."""

import pytest

from common.task_queues import open_account_task_queue


@pytest.mark.parametrize("value", [None, "", "  "])
def test_without_a_value_the_chat_queue_runs_it(monkeypatch, value):
    monkeypatch.delenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", raising=False)
    assert open_account_task_queue("OAI-Supervisor", value) == "OAI-Supervisor"


@pytest.mark.parametrize("value", ["java", "Java", " JAVA "])
def test_java_gives_the_port_its_own_open_account_queue(value):
    assert open_account_task_queue("OAI-Supervisor", value) == "OAI-Supervisor-open-account"
    assert open_account_task_queue("Pure-Supervisor", value) == "Pure-Supervisor-open-account"


def test_any_other_value_is_the_queue_name():
    assert open_account_task_queue("OAI-Supervisor", "My-Queue") == "My-Queue"


def test_reads_the_environment(monkeypatch):
    monkeypatch.setenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", "java")
    assert open_account_task_queue("ADK-Supervisor") == "ADK-Supervisor-open-account"
