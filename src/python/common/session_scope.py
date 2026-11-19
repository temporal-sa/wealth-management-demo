"""Browser sessions: which session a chat, and everything it does, belongs to.

Several people can use one running copy of the demo at once. The API gives each browser a random
session ID (a cookie) and starts its chat workflows with IDs that carry it:

    <framework's workflow ID prefix>session-<32 hex chars>-chat-<16 hex chars>

for example adk-go-temporal-agent-session-<session>-chat-<chat>. An open-account workflow's ID
starts with its chat's ID (OpenAccount-<chat workflow ID>-...), so the activities of a chat and of
its account openings can all find the session from their workflow ID. A workflow started some other
way (a test, a script, the CLI) has no session in its ID and uses the "default" session.

The session scopes the chaos flags (common/chaos_manager.py) and, with DEMO_DATA_STORE=redis, the
sample bank data (common/data_store.py). The TypeScript and Go frameworks follow the same rules
(src/typescript/common/session-scope.ts, src/go/internal/common/session).
"""

import re
import secrets
from typing import Optional

DEFAULT_SESSION = "default"
# A session's state in Redis (chaos flags, failure log, sample data) expires this long after its
# last change, so abandoned sessions don't pile up.
SESSION_TTL_SECONDS = 24 * 60 * 60

_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SESSION_IN_WORKFLOW_ID_RE = re.compile(r"session-([0-9a-f]{32})-chat-")


def new_session_id() -> str:
    return secrets.token_hex(16)


def is_session_id(value: Optional[str]) -> bool:
    return bool(value) and bool(_SESSION_ID_RE.match(value))


def chat_workflow_prefix(framework_prefix: str, session_id: str) -> str:
    """The start of every chat workflow ID of this session."""
    return f"{framework_prefix}session-{session_id}-chat-"


def new_chat_workflow_id(framework_prefix: str, session_id: str) -> str:
    return chat_workflow_prefix(framework_prefix, session_id) + secrets.token_hex(8)


def owns_workflow(framework_prefix: str, session_id: str, workflow_id: str) -> bool:
    """True if workflow_id is one of this session's chats."""
    prefix = chat_workflow_prefix(framework_prefix, session_id)
    return workflow_id.startswith(prefix) and len(workflow_id) > len(prefix)


def session_from_workflow_id(workflow_id: Optional[str]) -> str:
    """The session in a chat's or account opening's workflow ID, or the default session."""
    match = _SESSION_IN_WORKFLOW_ID_RE.search(workflow_id or "")
    return match.group(1) if match else DEFAULT_SESSION


def current_session() -> str:
    """The session of the workflow whose activity is running, or the default session outside one."""
    from temporalio import activity

    if not activity.in_activity():
        return DEFAULT_SESSION
    return session_from_workflow_id(activity.info().workflow_id)
