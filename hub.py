"""In-memory signaling state: one publisher (the iPad) and up to N viewers.

The Hub never touches media. It only remembers who is connected and forwards
JSON signaling messages between the publisher and each viewer. Every state
change happens under a single asyncio.Lock; network sends happen *outside*
the lock so one slow or dead socket can never stall the others.

A client is always identified by the exact object that registered it, never
by id alone. Two sockets can briefly share an id (a phone that reloads the
page keeps its device id), and the stale socket's cleanup must not evict the
new session.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

logger = logging.getLogger("petcam.hub")

Role = Literal["publisher", "viewer"]
Message = dict[str, Any]

# Application WebSocket close codes (4000-4999 are reserved for applications).
CLOSE_MALFORMED = 4400  # first message was not a valid auth message
CLOSE_UNAUTHORIZED = 4401  # wrong key
CLOSE_TIMEOUT = 4408  # no auth within 5 s, or no message within the heartbeat window
CLOSE_TOO_MANY_VIEWERS = 4409
CLOSE_REPLACED = 4410  # a newer session for the same role/device took over


class Socket(Protocol):
    """The subset of starlette.websockets.WebSocket the hub needs."""

    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


@dataclass(eq=False)
class Client:
    socket: Socket
    role: Role
    id: str
    ip: str
    connected_at: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)

    @property
    def tag(self) -> str:
        return f"{self.role}:{self.id}"

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    async def send(self, message: Message) -> bool:
        try:
            await self.socket.send_text(json.dumps(message))
            return True
        except Exception as exc:  # socket already closed, client gone, ...
            logger.warning("[%s] send of '%s' failed: %s", self.tag, message.get("type"), exc)
            return False

    async def close(self, code: int, reason: str) -> None:
        try:
            await self.socket.close(code=code, reason=reason)
        except Exception:
            pass  # already closed


class Hub:
    def __init__(self, max_viewers: int) -> None:
        self.max_viewers = max_viewers
        self.publisher: Client | None = None
        self.viewers: dict[str, Client] = {}
        self.relayed_messages = 0
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ status

    async def health(self) -> dict[str, object]:
        async with self._lock:
            return {
                "publisher": self.publisher is not None,
                "viewers": len(self.viewers),
                "max_viewers": self.max_viewers,
            }

    async def stale_clients(self, timeout_seconds: float) -> list[Client]:
        """Clients that have not sent anything (not even a ping) recently."""
        now = time.monotonic()
        async with self._lock:
            candidates: list[Client] = list(self.viewers.values())
            if self.publisher is not None:
                candidates.append(self.publisher)
        return [c for c in candidates if now - c.last_seen > timeout_seconds]

    # --------------------------------------------------------------- publisher

    async def attach_publisher(self, client: Client) -> None:
        """Register the publisher. A newer publisher always replaces the old one."""
        async with self._lock:
            old = self.publisher
            self.publisher = client
            viewers = list(self.viewers.values())

        if old is not None:
            logger.info("[%s] replaces publisher [%s]", client.tag, old.tag)
            await old.close(CLOSE_REPLACED, "Replaced by a new publisher session")
        logger.info("[%s] publisher online, notifying %d viewer(s)", client.tag, len(viewers))
        for viewer in viewers:
            await viewer.send({"type": "publisher_changed"})

    async def detach_publisher(self, client: Client) -> None:
        async with self._lock:
            if self.publisher is not client:
                return  # a newer publisher already took over; nothing to do
            self.publisher = None
            viewers = list(self.viewers.values())

        logger.info("[%s] publisher offline, notifying %d viewer(s)", client.tag, len(viewers))
        for viewer in viewers:
            await viewer.send({"type": "publisher_offline"})

    # ----------------------------------------------------------------- viewers

    async def attach_viewer(self, client: Client) -> bool:
        """Register a viewer. Returns False when the viewer limit is reached.

        A viewer reconnecting with the same device id (page reload, QR rescan,
        Wi-Fi to 5G switch) replaces its previous session instead of counting
        twice against the limit.
        """
        async with self._lock:
            previous = self.viewers.get(client.id)
            if previous is None and len(self.viewers) >= self.max_viewers:
                logger.warning(
                    "[%s] rejected: viewer limit reached (%d/%d)",
                    client.tag,
                    len(self.viewers),
                    self.max_viewers,
                )
                return False
            self.viewers[client.id] = client
            publisher = self.publisher
            count = len(self.viewers)

        if previous is not None:
            logger.info("[%s] replaces an earlier session from the same device", client.tag)
            await previous.close(CLOSE_REPLACED, "Replaced by a new session from this device")
            if publisher is not None:
                await publisher.send({"type": "viewer_left", "viewer_id": client.id})
        logger.info("[%s] viewer registered (%d/%d)", client.tag, count, self.max_viewers)
        return True

    async def detach_viewer(self, client: Client) -> None:
        async with self._lock:
            if self.viewers.get(client.id) is not client:
                return  # this socket was already replaced by a newer session
            del self.viewers[client.id]
            publisher = self.publisher
            remaining = len(self.viewers)

        logger.info("[%s] viewer left (%d remaining)", client.tag, remaining)
        if publisher is not None:
            await publisher.send({"type": "viewer_left", "viewer_id": client.id})

    async def viewer_join(self, client: Client) -> None:
        """Tell the viewer whether a camera is online and ask the publisher to offer."""
        async with self._lock:
            publisher = self.publisher

        await client.send({"type": "publisher_online" if publisher else "publisher_offline"})
        if publisher is not None:
            logger.info("[%s] join -> offer requested from [%s]", client.tag, publisher.tag)
            await publisher.send({"type": "viewer_joined", "viewer_id": client.id})

    # ------------------------------------------------------------------- relay

    async def to_publisher(self, message: Message) -> bool:
        async with self._lock:
            publisher = self.publisher
        if publisher is None:
            return False
        ok = await publisher.send(message)
        if ok:
            self.relayed_messages += 1
        return ok

    async def to_viewer(self, viewer_id: str, message: Message) -> bool:
        async with self._lock:
            viewer = self.viewers.get(viewer_id)
        if viewer is None:
            logger.info("dropped '%s' for unknown viewer [%s]", message.get("type"), viewer_id)
            return False
        ok = await viewer.send(message)
        if ok:
            self.relayed_messages += 1
        return ok
