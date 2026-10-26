from __future__ import annotations

import asyncio
import json

import pytest

from hub import CLOSE_REPLACED, Client, Hub


class FakeSocket:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list[dict] = []
        self.closed: tuple[int, str | None] | None = None
        self.fail = fail

    async def send_text(self, data: str) -> None:
        if self.fail:
            raise RuntimeError("socket gone")
        self.sent.append(json.loads(data))

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)

    def types(self) -> list[str]:
        return [m["type"] for m in self.sent]


def make(role: str, client_id: str, fail: bool = False) -> tuple[Client, FakeSocket]:
    sock = FakeSocket(fail=fail)
    return Client(socket=sock, role=role, id=client_id, ip="100.1.1.1"), sock


def run(coro):
    return asyncio.run(coro)


def test_health_counts() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=2)
        assert await hub.health() == {"publisher": False, "viewers": 0, "max_viewers": 2}
        pub, _ = make("publisher", "ipad")
        await hub.attach_publisher(pub)
        v, _ = make("viewer", "pixel")
        assert await hub.attach_viewer(v)
        assert await hub.health() == {"publisher": True, "viewers": 1, "max_viewers": 2}

    run(scenario())


def test_viewer_limit() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=1)
        a, _ = make("viewer", "a")
        b, _ = make("viewer", "b")
        assert await hub.attach_viewer(a)
        assert not await hub.attach_viewer(b)
        await hub.detach_viewer(a)
        assert await hub.attach_viewer(b)

    run(scenario())


def test_same_device_reconnect_replaces_without_evicting_new_session() -> None:
    """Regression: the old socket's cleanup must not remove the new session."""

    async def scenario() -> None:
        hub = Hub(max_viewers=1)
        pub, pub_sock = make("publisher", "ipad")
        await hub.attach_publisher(pub)

        old, old_sock = make("viewer", "pixel")
        assert await hub.attach_viewer(old)
        new, new_sock = make("viewer", "pixel")
        assert await hub.attach_viewer(new), "same device must not count against the limit"
        assert old_sock.closed == (CLOSE_REPLACED, "Replaced by a new session from this device")
        assert pub_sock.types() == ["viewer_left"]

        # The old socket's handler finishes afterwards, as it does in real life.
        await hub.detach_viewer(old)
        assert hub.viewers["pixel"] is new
        assert pub_sock.types() == ["viewer_left"], "no second viewer_left for the live session"

        # Offers for this viewer still reach the new socket.
        assert await hub.to_viewer("pixel", {"type": "offer", "sdp": "x"})
        assert new_sock.types() == ["offer"]
        assert old_sock.sent == []

    run(scenario())


def test_publisher_replacement_and_offline_notifications() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=2)
        viewer, viewer_sock = make("viewer", "pixel")
        await hub.attach_viewer(viewer)

        first, first_sock = make("publisher", "ipad-1")
        await hub.attach_publisher(first)
        second, second_sock = make("publisher", "ipad-2")
        await hub.attach_publisher(second)
        assert first_sock.closed is not None and first_sock.closed[0] == CLOSE_REPLACED
        assert viewer_sock.types() == ["publisher_changed", "publisher_changed"]

        await hub.detach_publisher(first)  # stale cleanup: must be a no-op
        assert hub.publisher is second
        assert "publisher_offline" not in viewer_sock.types()

        await hub.detach_publisher(second)
        assert hub.publisher is None
        assert viewer_sock.types()[-1] == "publisher_offline"

    run(scenario())


def test_join_and_relay() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=2)
        viewer, viewer_sock = make("viewer", "pixel")
        await hub.attach_viewer(viewer)

        await hub.viewer_join(viewer)
        assert viewer_sock.types() == ["publisher_offline"]

        pub, pub_sock = make("publisher", "ipad")
        await hub.attach_publisher(pub)
        await hub.viewer_join(viewer)
        assert viewer_sock.types()[-1] == "publisher_online"
        assert pub_sock.sent[-1] == {"type": "viewer_joined", "viewer_id": "pixel"}

        assert await hub.to_viewer("pixel", {"type": "offer", "sdp": "o", "session": "s1"})
        assert viewer_sock.sent[-1] == {"type": "offer", "sdp": "o", "session": "s1"}
        assert not await hub.to_viewer("ghost", {"type": "offer", "sdp": "o"})
        assert await hub.to_publisher({"type": "answer", "viewer_id": "pixel", "sdp": "a"})
        assert hub.relayed_messages == 2

    run(scenario())


def test_send_failures_do_not_raise() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=2)
        dead, _ = make("viewer", "dead", fail=True)
        await hub.attach_viewer(dead)
        pub, _ = make("publisher", "ipad", fail=True)
        await hub.attach_publisher(pub)  # publisher_changed to a dead viewer: swallowed
        assert not await hub.to_viewer("dead", {"type": "offer", "sdp": "x"})
        assert not await hub.to_publisher({"type": "answer", "sdp": "x"})
        assert hub.relayed_messages == 0

    run(scenario())


def test_stale_clients() -> None:
    async def scenario() -> None:
        hub = Hub(max_viewers=2)
        fresh, _ = make("viewer", "fresh")
        stale, _ = make("viewer", "stale")
        await hub.attach_viewer(fresh)
        await hub.attach_viewer(stale)
        stale.last_seen -= 100
        assert [c.id for c in await hub.stale_clients(30)] == ["stale"]

    run(scenario())


if __name__ == "__main__":
    pytest.main([__file__])
