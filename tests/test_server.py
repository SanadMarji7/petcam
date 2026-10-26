"""HTTP behaviour of the FastAPI control plane, driven through TestClient.

No test talks to a LiveKit server: `main.list_room_participants` and
`main.ensure_room` are replaced by a fake backed by a plain list, so the suite
passes with the container down.
"""
from __future__ import annotations

import re
import time

import pytest
from fastapi.testclient import TestClient
from livekit import api

import main
from config import Settings
from main import create_app, identity_for, parse_token_request, sanitize_device_id


class FakeRoom:
    """Stand-in for the LiveKit RoomService: a list of participants or an outage."""

    def __init__(self) -> None:
        self.participants: list[api.ParticipantInfo] = []
        self.unreachable = False
        self.create_calls: list[int] = []  # max_participants of every create_room call

    def add(self, identity: str, state: int = api.ParticipantInfo.State.ACTIVE) -> None:
        self.participants.append(api.ParticipantInfo(identity=identity, state=state))

    async def list_participants(self, settings: Settings) -> list[api.ParticipantInfo]:
        if self.unreachable:
            raise ConnectionError("Cannot connect to host 127.0.0.1:7880")
        return list(self.participants)

    async def ensure_room(self, settings: Settings) -> None:
        if self.unreachable:
            raise ConnectionError("Cannot connect to host 127.0.0.1:7880")
        self.create_calls.append(settings.max_viewers + 1)


@pytest.fixture
def room(monkeypatch: pytest.MonkeyPatch) -> FakeRoom:
    fake = FakeRoom()
    monkeypatch.setattr(main, "list_room_participants", fake.list_participants)
    monkeypatch.setattr(main, "ensure_room", fake.ensure_room)
    return fake


@pytest.fixture
def client(settings: Settings, room: FakeRoom):
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def local_client(settings: Settings, room: FakeRoom):
    """A client whose requests appear to come from the server's own loopback address."""
    with TestClient(create_app(settings), client=("127.0.0.1", 40000)) as c:
        yield c


def forget_recent_viewers(client: TestClient) -> None:
    """Pretend the join grace period for every recently minted viewer token has passed."""
    recent = client.app.state.recent_viewers
    for identity in list(recent):
        recent[identity] = time.monotonic() - 1


def token(client: TestClient, role: str, key: str, device_id: str | None = "dev1", **extra):
    body = {"role": role, "key": key, **extra}
    if device_id is not None:
        body["device_id"] = device_id
    return client.post("/api/token", json=body)


def decode(settings: Settings, jwt: str) -> api.Claims:
    return api.TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret).verify(jwt)


# ------------------------------------------------------------------ pages


def test_pages_and_headers(client: TestClient, settings: Settings) -> None:
    assert client.get("/", follow_redirects=False).headers["location"] == "/watch"
    for path in ("/cam", "/watch"):
        res = client.get(path)
        assert res.status_code == 200
        assert "/static/js/common.js" in res.text
        assert res.headers["Cache-Control"] == "no-store"
        csp = res.headers["Content-Security-Policy"]
        assert "frame-ancestors 'none'" in csp
        assert "script-src 'self';" in csp
        assert "connect-src 'self' ws://127.0.0.1:7880 http://127.0.0.1:7880;" in csp
        assert "media-src 'self' blob: mediastream:" in csp
        assert "worker-src 'self' blob:" in csp
        assert "'unsafe-inline'" not in csp.split("style-src")[0]
    assert client.get("/docs").status_code == 404
    assert client.get("/config.json").status_code == 404
    assert client.get("/static/js/common.js").status_code == 200
    assert client.get("/static/js/vendor/livekit-client.umd.js").status_code == 200


def test_csp_names_the_production_livekit_host(settings: Settings, room: FakeRoom) -> None:
    prod = Settings(**{**settings.__dict__, "livekit_url": "wss://lk.example.com"})
    with TestClient(create_app(prod)) as c:
        csp = c.get("/watch").headers["Content-Security-Policy"]
    assert "connect-src 'self' wss://lk.example.com https://lk.example.com;" in csp


# ------------------------------------------------------------------ tokens


def test_camera_token(client: TestClient, settings: Settings) -> None:
    res = token(client, "camera", settings.publisher_key, device_id="ipad-1")
    assert res.status_code == 200
    data = res.json()
    assert data["url"] == settings.livekit_url
    assert data["room"] == settings.room_name
    assert data["identity"] == "cam-ipad-1"
    assert data["ttl_seconds"] == 3600

    claims = decode(settings, data["token"])
    assert claims.identity == "cam-ipad-1"
    assert claims.name == "camera"
    grants = claims.video
    assert grants.room_join is True
    assert grants.room == settings.room_name
    assert grants.can_publish is True
    assert grants.can_subscribe is True
    assert grants.can_publish_data is True
    assert not grants.can_publish_sources
    assert not grants.room_admin


def test_viewer_token(client: TestClient, settings: Settings) -> None:
    res = token(client, "viewer", settings.viewer_key, device_id="pixel")
    assert res.status_code == 200
    data = res.json()
    assert data["identity"] == "viewer-pixel"
    claims = decode(settings, data["token"])
    assert claims.identity == "viewer-pixel"
    assert claims.name == "viewer"
    grants = claims.video
    assert grants.room_join is True
    assert grants.room == settings.room_name
    assert grants.can_publish is True
    assert grants.can_subscribe is True
    assert grants.can_publish_data is True
    assert grants.can_publish_sources == ["microphone"]


def test_token_ttl_is_one_hour(client: TestClient, settings: Settings) -> None:
    import base64
    import json
    import time

    jwt = token(client, "camera", settings.publisher_key).json()["token"]
    payload = jwt.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims["iss"] == settings.livekit_api_key
    assert 3590 <= claims["exp"] - time.time() <= 3600
    assert claims["exp"] - claims["nbf"] == 3600


def test_wrong_key(client: TestClient, settings: Settings) -> None:
    assert token(client, "camera", settings.viewer_key).status_code == 401
    assert token(client, "viewer", settings.publisher_key).status_code == 401
    res = token(client, "viewer", "nope")
    assert res.status_code == 401
    assert res.json() == {"error": "wrong_key"}


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"role": "publisher", "key": "x"}',
        b'{"role": "camera"}',
        b'{"role": "camera", "key": 5}',
        b'{"role": "camera", "key": ""}',
        b'{"role": "camera", "key": "x", "device_id": 7}',
    ],
)
def test_bad_body(client: TestClient, body: bytes) -> None:
    res = client.post("/api/token", content=body, headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert res.json() == {"error": "bad_request"}


def test_oversized_body_is_refused_before_it_is_read(client: TestClient, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    valid = b'{"role": "camera", "key": "%s", "device_id": "ipad"}' % settings.publisher_key.encode()
    padding = b" " * (main.MAX_BODY_BYTES + 1 - len(valid))

    # Content-Length says it all: nothing is read.
    streamed = []

    async def spy_stream(self):  # pragma: no cover - only runs if the guard is broken
        streamed.append(True)
        yield b""

    monkeypatch.setattr("starlette.requests.Request.stream", spy_stream)
    res = client.post("/api/token", content=valid + padding, headers={"content-type": "application/json"})
    assert res.status_code == 413
    assert res.json() == {"error": "bad_request"}
    assert streamed == []
    monkeypatch.undo()

    # No Content-Length (chunked): the stream is cut off at the limit.
    res = client.post("/api/token", content=iter([valid, padding]), headers={"content-type": "application/json"})
    assert res.status_code == 413

    # Exactly at the limit, the body is still parsed.
    res = client.post("/api/token", content=valid + padding[:-1], headers={"content-type": "application/json"})
    assert res.status_code == 200


def test_identity_sanitization(client: TestClient, settings: Settings) -> None:
    assert token(client, "camera", settings.publisher_key, device_id=" iPad Pro <script> ").json()["identity"] == "cam-iPadProscript"
    long = token(client, "viewer", settings.viewer_key, device_id="x" * 200).json()["identity"]
    assert long == "viewer-" + "x" * 64
    for empty in ("", "   ", "!!!", None):
        identity = token(client, "camera", settings.publisher_key, device_id=empty).json()["identity"]
        assert re.fullmatch(r"cam-[0-9a-f]{8}", identity), identity


def test_viewer_limit(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    room.add("cam-ipad")
    room.add("viewer-a")
    assert token(client, "viewer", settings.viewer_key, device_id="b").status_code == 200
    room.add("viewer-b")

    res = token(client, "viewer", settings.viewer_key, device_id="c")
    assert res.status_code == 409
    assert res.json() == {"error": "too_many_viewers"}
    # The same device reconnecting (reload, Wi-Fi to 5G) is not counted against itself.
    assert token(client, "viewer", settings.viewer_key, device_id="b").status_code == 200
    # A viewer that LiveKit already marked as gone does not take a seat, once
    # the grace period for the token it was just given is over.
    room.participants.pop()
    room.add("viewer-b", state=api.ParticipantInfo.State.DISCONNECTED)
    assert token(client, "viewer", settings.viewer_key, device_id="c").status_code == 409
    forget_recent_viewers(client)
    assert token(client, "viewer", settings.viewer_key, device_id="c").status_code == 200
    # The camera is never subject to the viewer limit.
    room.add("viewer-c")
    room.add("viewer-d")
    assert token(client, "camera", settings.publisher_key, device_id="ipad").status_code == 200


def test_viewer_limit_counts_tokens_minted_moments_ago(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    """Two phones asking at the same instant cannot both get the last seat."""
    room.add("cam-ipad")
    assert token(client, "viewer", settings.viewer_key, device_id="a").status_code == 200
    assert token(client, "viewer", settings.viewer_key, device_id="b").status_code == 200
    # Neither has joined yet as far as LiveKit knows, but both seats are spoken for.
    assert token(client, "viewer", settings.viewer_key, device_id="c").status_code == 409
    # Asking again from the same device is fine.
    assert token(client, "viewer", settings.viewer_key, device_id="a").status_code == 200
    # Once the grace period has passed and they never joined, the seats are free again.
    forget_recent_viewers(client)
    assert token(client, "viewer", settings.viewer_key, device_id="c").status_code == 200
    assert set(client.app.state.recent_viewers) == {"viewer-c"}


def test_viewer_limit_skipped_when_livekit_unreachable(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    room.add("viewer-a")
    room.add("viewer-b")
    room.unreachable = True
    assert token(client, "viewer", settings.viewer_key, device_id="c").status_code == 200


def test_room_is_created_with_a_participant_cap(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    """Every token request pins the room's max_participants to camera + max_viewers in LiveKit itself."""
    assert token(client, "camera", settings.publisher_key, device_id="ipad").status_code == 200
    assert token(client, "viewer", settings.viewer_key, device_id="a").status_code == 200
    assert room.create_calls == [settings.max_viewers + 1] * 2
    # A wrong key never touches LiveKit.
    assert token(client, "viewer", settings.publisher_key, device_id="a").status_code == 401
    assert len(room.create_calls) == 2


# ------------------------------------------------------------------ health


def test_healthz(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    assert client.get("/healthz").json() == {
        "livekit": True, "camera": False, "viewers": 0, "max_viewers": 2, "room": settings.room_name,
    }
    room.add("cam-ipad")
    room.add("viewer-a")
    room.add("viewer-b", state=api.ParticipantInfo.State.DISCONNECTED)
    room.add("something-else")
    assert client.get("/healthz").json() == {
        "livekit": True, "camera": True, "viewers": 1, "max_viewers": 2, "room": settings.room_name,
    }


def test_healthz_when_livekit_unreachable(client: TestClient, settings: Settings, room: FakeRoom) -> None:
    room.add("cam-ipad")
    room.unreachable = True
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"livekit": False, "camera": False, "viewers": 0, "max_viewers": 2, "room": settings.room_name}


def test_list_room_participants_handles_a_dead_server(settings: Settings) -> None:
    """The real API helpers (not the fake) fail fast when nothing listens on the port."""
    import asyncio

    dead = Settings(**{**settings.__dict__, "livekit_url": "ws://127.0.0.1:1"})
    with pytest.raises(Exception):
        asyncio.run(main.list_room_participants(dead))
    with pytest.raises(Exception):
        asyncio.run(main.ensure_room(dead))


# ------------------------------------------------------------- setup / qr


def test_setup_page_requires_the_startup_token(client: TestClient, local_client: TestClient, settings: Settings) -> None:
    denied = client.get("/setup")
    assert denied.status_code == 403
    assert settings.publisher_key not in denied.text
    assert settings.viewer_key not in denied.text
    assert "show-pairing.sh" in denied.text
    assert "python3 setup.py" in denied.text

    # Looking local is not enough: behind a layer-4 proxy every request looks local.
    assert local_client.get("/setup").status_code == 403
    assert local_client.get("/setup", headers={"x-forwarded-for": "203.0.113.9"}).status_code == 403
    assert settings.publisher_key not in local_client.get("/setup").text

    token_value = client.app.state.setup_token
    assert len(token_value) >= 32
    assert client.get("/setup", params={"token": token_value[:-1] + "x"}).status_code == 403
    assert client.get("/setup", params={"token": ""}).status_code == 403

    allowed = client.get("/setup", params={"token": token_value})
    assert allowed.status_code == 200
    assert settings.cam_pairing_url in allowed.text
    assert settings.watch_pairing_url in allowed.text
    assert allowed.text.count("<svg") == 2
    assert "Tailscale" not in allowed.text
    assert allowed.headers["Cache-Control"] == "no-store"


def test_setup_token_is_fresh_per_process_and_logged(settings: Settings, room: FakeRoom, caplog: pytest.LogCaptureFixture) -> None:
    first, second = create_app(settings), create_app(settings)
    assert first.state.setup_token != second.state.setup_token
    with caplog.at_level("INFO", logger="petcam"):
        with TestClient(first):
            pass
    assert any(f"/setup?token={first.state.setup_token}" in r.getMessage() for r in caplog.records)


def test_watch_qr_requires_viewer_key(client: TestClient, settings: Settings) -> None:
    assert client.get("/qr/watch.svg").status_code == 401
    assert client.get("/qr/watch.svg", headers={"x-petcam-key": "wrong"}).status_code == 401
    ok = client.get("/qr/watch.svg", headers={"x-petcam-key": settings.viewer_key})
    assert ok.status_code == 200
    assert ok.headers["content-type"].startswith("image/svg+xml")
    assert ok.text.startswith("<svg")


# -------------------------------------------------------------- helpers


def test_helpers() -> None:
    assert sanitize_device_id(" dev_ab-12 <script> ") == "dev_ab-12script"
    assert sanitize_device_id(None) == ""
    assert len(sanitize_device_id("x" * 200)) == 64
    assert identity_for("camera", "ipad") == "cam-ipad"
    assert identity_for("viewer", "") .startswith("viewer-")

    assert parse_token_request(b'{"role": "viewer", "key": "k"}') == {"role": "viewer", "key": "k", "device_id": ""}
    assert parse_token_request(b'{"role": "viewer", "key": "k", "device_id": null}') == {"role": "viewer", "key": "k", "device_id": ""}
    assert parse_token_request(b'{"role": "viewer", "key": "k", "pad": "' + b"a" * 20000 + b'"}') is None
