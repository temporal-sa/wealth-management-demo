"""How long a chat waits for the customer before it ends by itself.

A chat with no customer message and no account-opening status update for CHAT_IDLE_TIMEOUT ends
as it does on End Chat, so chats abandoned without End Chat (a closed tab) don't run forever. Its
open-account child workflows are terminated by their parent close policy.

Call chat_idle_timeout() from workflow code. The timer is behind a patch, so chats that started
before it existed replay without it instead of failing with a non-determinism error.
"""
from datetime import timedelta
from typing import Optional

from temporalio import workflow

CHAT_IDLE_TIMEOUT = timedelta(hours=1)
CHAT_IDLE_TIMEOUT_PATCH = "chat-idle-timeout"


def chat_idle_timeout() -> Optional[timedelta]:
    return CHAT_IDLE_TIMEOUT if workflow.patched(CHAT_IDLE_TIMEOUT_PATCH) else None
