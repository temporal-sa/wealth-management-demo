from typing import Optional, Protocol

from temporalio import activity

from common.status_update import StatusUpdate
from common.user_message import ChatInteraction


class EventStream(Protocol):
    """Where the conversation is published for the UI. EventStreamManager (Redis) in production."""

    async def append_chat_interaction(self, workflow_id: str, chat_interaction: ChatInteraction) -> int: ...

    async def append_status_update(self, workflow_id: str, status_update: StatusUpdate) -> int: ...

    async def delete_stream(self, workflow_id: str) -> bool: ...


class EventStreamActivities:
    """Activities that publish the conversation to the event stream the UI polls.

    Uses a new Redis connection per call unless given a stream (the tests pass an
    in-memory one).
    """

    def __init__(self, stream: Optional[EventStream] = None):
        self._stream = stream

    async def _call(self, method: str, *args):
        if self._stream is not None:
            return await getattr(self._stream, method)(*args)
        from common.event_stream_manager import EventStreamManager
        manager = EventStreamManager()
        try:
            return await getattr(manager, method)(*args)
        finally:
            await manager.close()

    @activity.defn
    async def append_chat_interaction(self, workflow_id: str, chat_interaction: ChatInteraction) -> int:
        """Append a chat interaction to the event stream."""
        sequence = await self._call("append_chat_interaction", workflow_id, chat_interaction)
        activity.logger.info(f"Appended chat interaction to stream {workflow_id}, sequence {sequence}")
        return sequence

    @activity.defn
    async def append_status_update(self, workflow_id: str, status_update: StatusUpdate) -> int:
        """Append a status update to the event stream."""
        sequence = await self._call("append_status_update", workflow_id, status_update)
        activity.logger.info(f"Appended status update to stream {workflow_id}, sequence {sequence}")
        return sequence

    @activity.defn
    async def delete_conversation(self, workflow_id: str) -> bool:
        """Delete an earlier conversation stored under this workflow ID."""
        return await self._call("delete_stream", workflow_id)


class InMemoryEventStream:
    """An event stream kept in memory, for tests."""

    def __init__(self):
        self.events: dict[str, list[dict]] = {}

    async def append_chat_interaction(self, workflow_id: str, chat_interaction: ChatInteraction) -> int:
        return self._append(workflow_id, "chat_interaction", chat_interaction)

    async def append_status_update(self, workflow_id: str, status_update: StatusUpdate) -> int:
        return self._append(workflow_id, "status_update", status_update)

    async def delete_stream(self, workflow_id: str) -> bool:
        return self.events.pop(workflow_id, None) is not None

    def _append(self, workflow_id: str, event_type: str, content) -> int:
        events = self.events.setdefault(workflow_id, [])
        events.append({"type": event_type, "content": content})
        return len(events)
