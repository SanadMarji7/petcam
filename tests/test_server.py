"""HTTP and WebSocket behaviour of the FastAPI app, driven through TestClient."""
from __future__ import annotations

from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from config import Settings
from hub import CLOSE_MALFORMED, CLOSE_REPLACED, CLOSE_TIMEOUT, CLOSE_TOO_MANY_VIEWERS, CLOSE_UNAUTHORIZED
from main import create_app, is_local_request, origin_allowed, parse_message, sanitize_device_id

ORIGIN = {"origin": "https://dogcam.test.ts.net"}


@pytest.fixture
def client(settings: Settings):
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def local_client(settings: Settings):
    with TestClient(create_app(settings), client=("127.0.0.1", 40000)) as c:
        yield c


@pytest.fixture
def sockets():
    """Every WebSocket session opened through connect() is closed at test end."""
    with ExitStack() as stack:
        yield stack


def connect(stack: ExitStack, client: TestClient, role: str, key: str, device_id: str | None = None):
    ws = stack.enter_context(client.websocket_connect(f"/ws/{role}", headers=ORIGIN))
    auth = {"type": "auth", "key": key}
    if device_id:
        auth["device_id"] = device_id
    ws.send_json(auth)
    return ws


def close_code(ws) -> int:
    with pytest.raises(WebSocketDisconnect) as info:
        ws.receive_json()
    return info.value.code


# ------------------------------------------------------------------ http


def test_pages_and_headers(client: TestClient) -> None:
    assert client.get("/", follow_redirects=False).headers["location"] == "/watch"
    for path in ("/cam", "/watch"):
        res = client.get(path)
        assert res.status_code == 200
        assert "/static/js/common.js" in res.text
        assert res.headers["Cache-Control"] == "no-store"
        assert "frame-ancestors 'none'" in res.headers["Content-Security-Policy"]
        assert "'unsafe-inline'" not in res.headers["Content-Security-Policy"].split("style-src")[0]
    assert client.get("/docs").status_code == 404
    assert client.get("/static/js/watch.js").status_code == 200


def test_health_and_config(client: TestClient, settings: Settings) -> None:
    assert client.get("/healthz").json() == {"publisher": False, "viewers": 0, "max_viewers": settings.max_viewers}
    assert client.get("/config.json").json() == {"stun_enabled": False, "ice_servers": []}


def test_config_json_with_stun(settings: Settings) -> None:
    with TestClient(create_app(Settings(**{**settings.__dict__, "stun_enabled": True}))) as c:
        data = c.get("/config.json").json()
        assert data["stun_enabled"] is True
        assert data["ice_servers"][0]["urls"].startswith("stun:")


def test_setup_page_only_for_local_requests(client: TestClient, local_client: TestClient, settings: Settings) -> None:
    denied = client.get("/setup")
    assert denied.status_code == 403
    assert settings.publisher_key not in denied.text
    assert "python3 setup.py" in denied.text

    proxied = local_client.get("/setup", headers={"x-forwarded-for": "100.64.0.9"})
    assert proxied.status_code == 403

    allowed = local_client.get("/setup")
    assert allowed.status_code == 200
    assert settings.cam_pairing_url in allowed.text
    assert settings.watch_pairing_url in allowed.text
    assert allowed.text.count("<svg") == 2


def test_watch_qr_requires_viewer_key(client: TestClient, settings: Settings) -> None:
    assert client.get("/qr/watch.svg").status_code == 401
    assert client.get("/qr/watch.svg", headers={"x-petcam-key": "wrong"}).status_code == 401
    ok = client.get("/qr/watch.svg", headers={"x-petcam-key": settings.viewer_key})
    assert ok.status_code == 200
    assert ok.headers["content-type"].startswith("image/svg+xml")
    assert ok.text.startswith("<svg")


# -------------------------------------------------------------- helpers


def test_origin_allowed() -> None:
    assert origin_allowed(None, "dogcam.ts.net")
    assert origin_allowed("https://dogcam.ts.net", "dogcam.ts.net")
    assert origin_allowed("https://DOGCAM.ts.net:443", "dogcam.ts.net")
    assert origin_allowed("http://localhost:8000", "dogcam.ts.net")
    assert origin_allowed("http://127.0.0.1:8000", "dogcam.ts.net")
    assert not origin_allowed("https://evil.example", "dogcam.ts.net")
    assert not origin_allowed("https://dogcam.ts.net.evil.example", "dogcam.ts.net")


def test_parse_message_and_device_id() -> None:
    assert parse_message('{"type": "ping"}') == {"type": "ping"}
    assert parse_message("not json") is None
    assert parse_message('{"no": "type"}') is None
    assert parse_message('{"type": 5}') is None
    assert parse_message('{"type": "x", "pad": "' + "a" * 70000 + '"}') is None
    assert sanitize_device_id(" dev_ab-12 <script> ") == "dev_ab-12script"
    assert sanitize_device_id(None) == ""
    assert len(sanitize_device_id("x" * 200)) == 64


class _Req:
    def __init__(self, host: str, headers: dict[str, str]) -> None:
        self.client = type("C", (), {"host": host})()
        self.headers = headers


def test_is_local_request() -> None:
    assert is_local_request(_Req("127.0.0.1", {}))
    assert not is_local_request(_Req("100.64.0.1", {}))
    assert not is_local_request(_Req("127.0.0.1", {"x-forwarded-for": "100.64.0.1"}))
    assert not is_local_request(_Req("127.0.0.1", {"x-forwarded-host": "dogcam.ts.net"}))


# ------------------------------------------------------------ websockets


def test_rejects_bad_origin(client: TestClient, settings: Settings) -> None:
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect("/ws/viewer", headers={"origin": "https://evil.example"}):
            pass
    assert info.value.code == 1008


def test_auth_failures(client: TestClient, sockets: ExitStack, settings: Settings) -> None:
    ws = connect(sockets, client, "viewer", "wrong-key")
    assert close_code(ws) == CLOSE_UNAUTHORIZED

    with client.websocket_connect("/ws/publisher", headers=ORIGIN) as ws:
        ws.send_text("garbage")
        assert close_code(ws) == CLOSE_MALFORMED

    with client.websocket_connect("/ws/publisher", headers=ORIGIN) as ws:
        ws.send_json({"type": "offer", "sdp": "x"})
        assert close_code(ws) == CLOSE_MALFORMED

    # The viewer key must not open the publisher socket.
    ws = connect(sockets, client, "publisher", settings.viewer_key)
    assert close_code(ws) == CLOSE_UNAUTHORIZED


def test_auth_timeout(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "AUTH_TIMEOUT_SECONDS", 0.2)
    with TestClient(create_app(settings)) as c:
        with c.websocket_connect("/ws/viewer", headers=ORIGIN) as ws:
            assert close_code(ws) == CLOSE_TIMEOUT


def test_full_signaling_exchange(client: TestClient, sockets: ExitStack, settings: Settings) -> None:
    pub = connect(sockets, client, "publisher", settings.publisher_key, device_id="ipad")
    assert pub.receive_json() == {"type": "auth_ok", "id": "ipad"}

    viewer = connect(sockets, client, "viewer", settings.viewer_key, device_id="pixel")
    assert viewer.receive_json() == {"type": "auth_ok", "id": "pixel"}
    assert client.get("/healthz").json() == {"publisher": True, "viewers": 1, "max_viewers": 2}

    viewer.send_json({"type": "join"})
    assert viewer.receive_json() == {"type": "publisher_online"}
    assert pub.receive_json() == {"type": "viewer_joined", "viewer_id": "pixel"}

    pub.send_json({"type": "offer", "viewer_id": "pixel", "session": "s1", "restart": False, "sdp": "OFFER", "extra": "dropped"})
    assert viewer.receive_json() == {"type": "offer", "session": "s1", "restart": False, "sdp": "OFFER"}

    viewer.send_json({"type": "answer", "session": "s1", "sdp": "ANSWER"})
    assert pub.receive_json() == {"type": "answer", "viewer_id": "pixel", "session": "s1", "sdp": "ANSWER"}

    pub.send_json({"type": "ice", "viewer_id": "pixel", "session": "s1", "candidate": {"candidate": "c1"}})
    assert viewer.receive_json() == {"type": "ice", "session": "s1", "candidate": {"candidate": "c1"}}
    viewer.send_json({"type": "ice", "session": "s1", "candidate": {"candidate": "c2"}})
    assert pub.receive_json() == {"type": "ice", "viewer_id": "pixel", "session": "s1", "candidate": {"candidate": "c2"}}

    viewer.send_json({"type": "quality", "quality": "high"})
    assert pub.receive_json() == {"type": "viewer_quality", "viewer_id": "pixel", "quality": "high"}
    viewer.send_json({"type": "quality", "quality": "bogus"})
    assert pub.receive_json() == {"type": "viewer_quality", "viewer_id": "pixel", "quality": "auto"}
    viewer.send_json({"type": "restart"})
    assert pub.receive_json() == {"type": "viewer_restart", "viewer_id": "pixel"}

    viewer.send_json({"type": "ping"})
    assert viewer.receive_json() == {"type": "pong"}
    pub.send_json({"type": "ping"})
    assert pub.receive_json() == {"type": "pong"}

    # Dropped without crashing: unknown type, offer without sdp, offer to nobody.
    pub.send_json({"type": "nonsense"})
    pub.send_json({"type": "offer", "viewer_id": "pixel"})
    pub.send_json({"type": "offer", "viewer_id": "ghost", "sdp": "x"})
    pub.send_json({"type": "ping"})
    assert pub.receive_json() == {"type": "pong"}

    viewer.close()
    assert pub.receive_json() == {"type": "viewer_left", "viewer_id": "pixel"}

    pub.close()
    assert client.get("/healthz").json()["publisher"] is False


def test_viewer_reconnect_with_same_device_keeps_new_session(client: TestClient, sockets: ExitStack, settings: Settings) -> None:
    """Regression for the bug that left phones stuck on 'connecting' after a reload."""
    pub = connect(sockets, client, "publisher", settings.publisher_key, device_id="ipad")
    pub.receive_json()

    old = connect(sockets, client, "viewer", settings.viewer_key, device_id="pixel")
    old.receive_json()
    old.send_json({"type": "join"})
    old.receive_json()
    assert pub.receive_json()["type"] == "viewer_joined"

    new = connect(sockets, client, "viewer", settings.viewer_key, device_id="pixel")
    assert new.receive_json() == {"type": "auth_ok", "id": "pixel"}
    assert close_code(old) == CLOSE_REPLACED
    assert pub.receive_json() == {"type": "viewer_left", "viewer_id": "pixel"}

    new.send_json({"type": "join"})
    assert new.receive_json() == {"type": "publisher_online"}
    assert pub.receive_json() == {"type": "viewer_joined", "viewer_id": "pixel"}

    # The offer must reach the new socket even though the old one has now been cleaned up.
    pub.send_json({"type": "offer", "viewer_id": "pixel", "session": "s2", "sdp": "OFFER"})
    assert new.receive_json() == {"type": "offer", "session": "s2", "sdp": "OFFER"}
    assert client.get("/healthz").json()["viewers"] == 1

    new.close()
    assert pub.receive_json() == {"type": "viewer_left", "viewer_id": "pixel"}
    pub.close()


def test_viewer_limit_and_publisher_replacement(client: TestClient, sockets: ExitStack, settings: Settings) -> None:
    a = connect(sockets, client, "viewer", settings.viewer_key, device_id="a")
    a.receive_json()
    b = connect(sockets, client, "viewer", settings.viewer_key, device_id="b")
    b.receive_json()
    c = connect(sockets, client, "viewer", settings.viewer_key, device_id="c")
    c.receive_json()
    assert c.receive_json() == {"type": "error", "reason": "too_many_viewers"}
    assert close_code(c) == CLOSE_TOO_MANY_VIEWERS

    first = connect(sockets, client, "publisher", settings.publisher_key, device_id="ipad")
    first.receive_json()
    assert a.receive_json() == {"type": "publisher_changed"}
    assert b.receive_json() == {"type": "publisher_changed"}

    second = connect(sockets, client, "publisher", settings.publisher_key, device_id="ipad")
    second.receive_json()
    assert close_code(first) == CLOSE_REPLACED
    assert a.receive_json() == {"type": "publisher_changed"}
    assert b.receive_json() == {"type": "publisher_changed"}
    assert client.get("/healthz").json() == {"publisher": True, "viewers": 2, "max_viewers": 2}

    second.close()
    assert a.receive_json() == {"type": "publisher_offline"}
    assert b.receive_json() == {"type": "publisher_offline"}
    a.close()
    b.close()


# ------------------------------------------------------- mDNS unmasking


def test_tailscale_ip_helpers() -> None:
    from main import has_real_candidate, is_tailscale_ip, routable_ip, unmask_mdns

    assert is_tailscale_ip("100.82.199.26")
    assert is_tailscale_ip("fd7a:115c:a1e0::6a4e:c71b")
    assert not is_tailscale_ip("192.168.2.181")
    assert not is_tailscale_ip("garbage")

    assert routable_ip("100.82.199.26", "") == "100.82.199.26"
    assert routable_ip("127.0.0.1", "100.1.1.1") == "100.1.1.1"
    assert routable_ip("127.0.0.1", "") == ""
    assert routable_ip("192.168.2.181", "100.1.1.1") == ""

    cand = {"candidate": "candidate:1 1 udp 2122 93cbf8bf-b7ea-459e-9221-22c6645bb206.local 5000 typ host", "sdpMid": "0"}
    out = unmask_mdns({"candidate": cand, "session": "s"}, "100.64.0.5")
    assert out["candidate"]["candidate"] == "candidate:1 1 udp 2122 100.64.0.5 5000 typ host"
    assert out["candidate"]["sdpMid"] == "0"
    assert cand["candidate"].endswith(".local 5000 typ host"), "input not mutated"
    sdp = "v=0\r\na=candidate:1 1 udp 2122 1c69a762-f518-4a90-9571-a4f2af23325c.local 6000 typ host\r\nc=IN IP4 0.0.0.0\r\n"
    assert "100.64.0.5 6000" in unmask_mdns({"sdp": sdp}, "100.64.0.5")["sdp"]
    assert unmask_mdns({"sdp": sdp}, "") == {"sdp": sdp}
    assert unmask_mdns({"sdp": "a=candidate:1 1 udp 2122 192.168.1.2 7 typ host"}, "100.64.0.5")["sdp"].endswith("192.168.1.2 7 typ host")

    assert has_real_candidate({"candidate": {"candidate": "candidate:1 ..."}})
    assert not has_real_candidate({"candidate": {"candidate": ""}})
    assert not has_real_candidate({"candidate": None})
    assert not has_real_candidate({})


def test_relay_unmasks_mdns_for_tailnet_clients(settings: Settings) -> None:
    with TestClient(create_app(settings), client=("100.64.0.9", 40000)) as client, ExitStack() as sockets:
        pub = connect(sockets, client, "publisher", settings.publisher_key, device_id="ipad")
        pub.receive_json()
        viewer = connect(sockets, client, "viewer", settings.viewer_key, device_id="pixel")
        viewer.receive_json()
        viewer.send_json({"type": "join"})
        viewer.receive_json()
        pub.receive_json()

        pub.send_json({"type": "offer", "viewer_id": "pixel", "session": "s",
                       "sdp": "a=candidate:1 1 udp 1 abcdef12-3456.local 9 typ host"})
        assert viewer.receive_json()["sdp"] == "a=candidate:1 1 udp 1 100.64.0.9 9 typ host"

        viewer.send_json({"type": "ice", "session": "s", "candidate": {"candidate": "candidate:1 1 udp 1 abcdef12-3456.local 9 typ host"}})
        viewer.send_json({"type": "ice", "session": "s", "candidate": {"candidate": ""}})  # end-of-candidates: dropped
        viewer.send_json({"type": "ping"})
        assert pub.receive_json()["candidate"]["candidate"] == "candidate:1 1 udp 1 100.64.0.9 9 typ host"
        assert viewer.receive_json() == {"type": "pong"}
        pub.send_json({"type": "ice", "viewer_id": "pixel", "session": "s", "candidate": {"candidate": ""}})
        pub.send_json({"type": "ping"})
        assert pub.receive_json() == {"type": "pong"}
