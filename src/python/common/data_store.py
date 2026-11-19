"""Where the demo's sample bank data (data/*.json) is read from and written to.

DEMO_DATA_STORE=file (the default): the JSON files themselves, as when one person runs the demo
locally (git checkout data/ resets them).

DEMO_DATA_STORE=redis: one copy of each file per browser session (see session_scope.py), in Redis
under data:<session>:<name>, for example data:<session>:investments. A session's first read starts
from the file in data/, its writes never touch the file, and its copy expires a day after its last
change. This is what a shared, multi-user deployment uses: everyone gets their own client 123, and
two frameworks no longer overwrite each other's changes. The TypeScript and Go frameworks use the
same keys and format (src/typescript/common/data-store.ts, src/go/internal/common/data).
"""

import json
import os
from typing import Any, Optional

from common.redis_config import RedisConfig
from common.session_scope import SESSION_TTL_SECONDS, current_session


def use_redis() -> bool:
    return os.getenv("DEMO_DATA_STORE", "file").strip().lower() == "redis"


def redis_key(session_id: str, name: str) -> str:
    return f"data:{session_id}:{name}"


_redis_client = None


def _shared_redis():
    # One connection pool per process, shared by every activity
    global _redis_client
    if _redis_client is None:
        _redis_client = RedisConfig().sync_client()
    return _redis_client


class JsonDocument:
    """One sample data file, as the current session sees it.

    The session is looked up on every load and save (the running activity's), so a document can be
    created anywhere, even at import time.
    """

    def __init__(self, file_path: str, name: Optional[str] = None, session_id: Optional[str] = None):
        self.file_path = file_path
        # The file's name without .json: clients, beneficiaries, investments or funding_accounts
        self.name = name or os.path.splitext(os.path.basename(file_path))[0]
        self._session_id = session_id

    def _key(self) -> str:
        return redis_key(self._session_id or current_session(), self.name)

    def _read_file(self) -> Optional[Any]:
        if not os.path.exists(self.file_path) or os.stat(self.file_path).st_size == 0:
            return None
        with open(self.file_path, "r") as f:
            return json.load(f)

    def load(self) -> Optional[Any]:
        """The document, or None if it doesn't exist or is empty. Raises on invalid JSON."""
        if use_redis():
            raw = _shared_redis().get(self._key())
            if raw is not None:
                return json.loads(raw)
        return self._read_file()

    def save(self, data: Any, indent: int = 4) -> None:
        if use_redis():
            _shared_redis().set(self._key(), json.dumps(data), ex=SESSION_TTL_SECONDS)
            return
        with open(self.file_path, "w") as f:
            json.dump(data, f, indent=indent)
