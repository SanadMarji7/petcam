"""Petcam signaling server.

Serves the two pages (/cam for the iPad, /watch for phones and laptops) and
relays WebRTC signaling between them over WebSockets. Media never touches this
process: once the offer/answer exchange is done the video flows peer to peer
between the iPad and each viewer.

Run with:  uvicorn main:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import logging
import re
import secrets
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlparse

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from config import ConfigError, Settings, load_settings
from hub import (
    CLOSE_MALFORMED,
    CLOSE_TIMEOUT,
    CLOSE_TOO_MANY_VIEWERS,
    CLOSE_UNAUTHORIZED,
    Client,
    Hub,
    Message,
    Role,
)
from qrgen import qr_svg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("petcam")

BASE_DIR = Path(__file__).resolve().parent

MAX_MESSAGE_BYTES = 64 * 1024
AUTH_TIMEOUT_SECONDS = 5.0
HEARTBEAT_TIMEOUT_SECONDS = 30.0
HEARTBEAT_CHECK_INTERVAL_SECONDS = 5.0
STATS_LOG_INTERVAL_SECONDS = 60.0
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# Fields a client may attach to a relayed message. Everything else is dropped.
RELAY_FIELDS = ("sdp", "candidate", "session", "restart")
# Browsers hide host candidates behind random mDNS names ("<uuid>.local") on
# pages without camera permission (the viewer) and, on iOS, for VPN interfaces.
# Those names cannot be resolved across the tailnet, so the relay swaps them for
# the sender's Tailscale IP, which the server learns from tailscale serve.
MDNS_NAME = re.compile(r"\b[0-9a-fA-F-]{8,}\.local\b")
TAILSCALE_NETWORKS = (ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48"))

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self' wss: ws:; "
        "media-src 'self' blob: mediastream:; "
        "manifest-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    ),
}


# ----------------------------------------------------------------- helpers


def origin_allowed(origin: str | None, hostname: str) -> bool:
    """Only pages served from our own hostname (or localhost in dev) may open a socket."""
    if not origin:
        return True  # non-browser clients; they still need the key
    host = (urlparse(origin).hostname or "").lower()
    expected = hostname.split(":", 1)[0].lower()
    return host == expected or host in LOOPBACK_HOSTS


def is_local_request(request: Request) -> bool:
    """True only for requests made on the server itself, not via tailscale serve.

    tailscale serve always adds X-Forwarded-* headers to proxied requests, so a
    bare loopback request without them can only come from this machine.
    """
    host = request.client.host if request.client else ""
    forwarded = any(name in request.headers for name in ("x-forwarded-for", "x-forwarded-host", "forwarded"))
    return host in ("127.0.0.1", "::1") and not forwarded


def is_tailscale_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in TAILSCALE_NETWORKS)


def detect_server_tailscale_ip() -> str:
    """This machine's own Tailscale IPv4, for pages opened on the server itself."""
    try:
        out = subprocess.check_output(["tailscale", "ip", "-4"], text=True, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        return ""
    ip = out.strip().splitlines()[0].strip() if out.strip() else ""
    return ip if is_tailscale_ip(ip) else ""


def routable_ip(client_ip: str, server_tailscale_ip: str) -> str:
    """The address other tailnet devices can reach this client on, or '' if unknown."""
    if is_tailscale_ip(client_ip):
        return client_ip
    if client_ip in ("127.0.0.1", "::1") and server_tailscale_ip:
        return server_tailscale_ip
    return ""


def unmask_mdns(payload: Message, ip: str) -> Message:
    """Replace '<uuid>.local' in an offer/answer SDP or an ICE candidate with `ip`."""
    if not ip:
        return payload
    result = dict(payload)
    sdp = result.get("sdp")
    if isinstance(sdp, str) and ".local" in sdp:
        result["sdp"] = MDNS_NAME.sub(ip, sdp)
    candidate = result.get("candidate")
    if isinstance(candidate, dict) and isinstance(candidate.get("candidate"), str) and ".local" in candidate["candidate"]:
        candidate = dict(candidate)
        candidate["candidate"] = MDNS_NAME.sub(ip, candidate["candidate"])
        result["candidate"] = candidate
    return result


def has_real_candidate(payload: Message) -> bool:
    """False for end-of-candidates signals (empty string), which make Safari throw."""
    candidate = payload.get("candidate")
    if candidate is None:
        return False
    if isinstance(candidate, dict):
        return bool(str(candidate.get("candidate") or "").strip())
    return bool(str(candidate).strip())


def parse_message(raw: str) -> Message | None:
    if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("type"), str):
        return None
    return data


def sanitize_device_id(value: object) -> str:
    text = str(value or "").strip()[:64]
    return "".join(ch for ch in text if ch.isalnum() or ch in "_-")


def relay_payload(message: Message) -> Message:
    return {name: message[name] for name in RELAY_FIELDS if name in message}


# ---------------------------------------------------------- websocket logic


async def authenticate(websocket: WebSocket, expected_key: str, role: Role, ip: str) -> str | None:
    """First frame must be {"type":"auth","key":...} within 5 s. Returns the client id."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("[%s] auth timeout from %s", role, ip)
        await websocket.close(code=CLOSE_TIMEOUT, reason="Auth timeout")
        return None
    except (WebSocketDisconnect, RuntimeError):
        return None

    message = parse_message(raw)
    if message is None or message.get("type") != "auth" or not isinstance(message.get("key"), str):
        logger.warning("[%s] malformed auth message from %s", role, ip)
        await websocket.close(code=CLOSE_MALFORMED, reason="Expected an auth message")
        return None

    if not hmac.compare_digest(message["key"].encode("utf-8"), expected_key.encode("utf-8")):
        logger.warning("[%s] wrong key from %s", role, ip)
        await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Authentication failed")
        return None

    client_id = sanitize_device_id(message.get("device_id")) or secrets.token_hex(4)
    await websocket.send_text(json.dumps({"type": "auth_ok", "id": client_id}))
    logger.info("[%s:%s] authenticated from %s", role, client_id, ip)
    return client_id


async def handle_publisher_message(hub: Hub, client: Client, message: Message, reachable_ip: str) -> None:
    kind = message["type"]
    if kind == "ping":
        await client.send({"type": "pong"})
        return
    if kind in ("offer", "ice"):
        viewer_id = message.get("viewer_id")
        if not isinstance(viewer_id, str) or not viewer_id:
            logger.warning("[%s] '%s' without viewer_id dropped", client.tag, kind)
            return
        payload = unmask_mdns(relay_payload(message), reachable_ip)
        if kind == "offer" and not isinstance(payload.get("sdp"), str):
            logger.warning("[%s] offer without sdp dropped", client.tag)
            return
        if kind == "ice" and not has_real_candidate(payload):
            return
        await hub.to_viewer(viewer_id, {"type": kind, **payload})
        return
    logger.warning("[%s] unknown message type '%s' dropped", client.tag, kind)


async def handle_viewer_message(hub: Hub, client: Client, message: Message, reachable_ip: str) -> None:
    kind = message["type"]
    if kind == "ping":
        await client.send({"type": "pong"})
    elif kind == "join":
        await hub.viewer_join(client)
    elif kind == "answer":
        payload = unmask_mdns(relay_payload(message), reachable_ip)
        if not isinstance(payload.get("sdp"), str):
            logger.warning("[%s] answer without sdp dropped", client.tag)
            return
        await hub.to_publisher({"type": "answer", "viewer_id": client.id, **payload})
    elif kind == "ice":
        payload = unmask_mdns(relay_payload(message), reachable_ip)
        if not has_real_candidate(payload):
            return
        await hub.to_publisher({"type": "ice", "viewer_id": client.id, **payload})
    elif kind == "restart":
        await hub.to_publisher({"type": "viewer_restart", "viewer_id": client.id})
    elif kind == "quality":
        quality = message.get("quality")
        if quality not in ("auto", "high"):
            quality = "auto"
        await hub.to_publisher({"type": "viewer_quality", "viewer_id": client.id, "quality": quality})
    else:
        logger.warning("[%s] unknown message type '%s' dropped", client.tag, kind)


async def run_session(websocket: WebSocket, role: Role, settings: Settings, hub: Hub, server_tailscale_ip: str = "") -> None:
    ip = websocket.client.host if websocket.client else "unknown"
    if not origin_allowed(websocket.headers.get("origin"), settings.hostname):
        logger.warning("[%s] rejected origin %r from %s", role, websocket.headers.get("origin"), ip)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Origin not allowed")
        return

    await websocket.accept()
    expected_key = settings.publisher_key if role == "publisher" else settings.viewer_key
    client_id = await authenticate(websocket, expected_key, role, ip)
    if client_id is None:
        return

    client = Client(socket=websocket, role=role, id=client_id, ip=ip)
    reachable_ip = routable_ip(ip, server_tailscale_ip)
    if reachable_ip:
        logger.info("[%s] mDNS candidates will be rewritten to %s", client.tag, reachable_ip)
    if role == "publisher":
        await hub.attach_publisher(client)
    elif not await hub.attach_viewer(client):
        await client.send({"type": "error", "reason": "too_many_viewers"})
        await client.close(CLOSE_TOO_MANY_VIEWERS, "Viewer limit reached")
        return

    try:
        while True:
            raw = await websocket.receive_text()
            client.touch()
            message = parse_message(raw)
            if message is None:
                logger.warning("[%s] dropped an invalid or oversized message", client.tag)
                continue
            if role == "publisher":
                await handle_publisher_message(hub, client, message, reachable_ip)
            else:
                await handle_viewer_message(hub, client, message, reachable_ip)
    except WebSocketDisconnect as exc:
        logger.info("[%s] disconnected (code %s)", client.tag, exc.code)
    except RuntimeError:
        pass  # socket was closed by the hub (replaced / heartbeat timeout)
    except Exception as exc:
        logger.warning("[%s] session error: %s", client.tag, exc)
    finally:
        if role == "publisher":
            await hub.detach_publisher(client)
        else:
            await hub.detach_viewer(client)


async def heartbeat_watchdog(hub: Hub) -> None:
    """Close sockets that went silent and log a one-line summary every minute."""
    last_stats = time.monotonic()
    while True:
        await asyncio.sleep(HEARTBEAT_CHECK_INTERVAL_SECONDS)
        try:
            for client in await hub.stale_clients(HEARTBEAT_TIMEOUT_SECONDS):
                logger.warning("[%s] no heartbeat for %.0fs, closing", client.tag, HEARTBEAT_TIMEOUT_SECONDS)
                await client.close(CLOSE_TIMEOUT, "Heartbeat timeout")
            if time.monotonic() - last_stats >= STATS_LOG_INTERVAL_SECONDS:
                health = await hub.health()
                logger.info(
                    "[stats] publisher=%s viewers=%s relayed=%d",
                    "online" if health["publisher"] else "offline",
                    health["viewers"],
                    hub.relayed_messages,
                )
                last_stats = time.monotonic()
        except Exception as exc:  # never let the watchdog die
            logger.error("watchdog error: %s", exc)


# ---------------------------------------------------------------- app factory


def create_app(settings: Settings) -> FastAPI:
    hub = Hub(max_viewers=settings.max_viewers)
    templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
    server_tailscale_ip = detect_server_tailscale_ip()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("Petcam starting: hostname=%s max_viewers=%d stun=%s port=%d tailscale_ip=%s",
                    settings.hostname, settings.max_viewers, settings.stun_enabled, settings.port,
                    server_tailscale_ip or "none")
        watchdog = asyncio.create_task(heartbeat_watchdog(hub))
        try:
            yield
        finally:
            watchdog.cancel()
            try:
                await watchdog
            except asyncio.CancelledError:
                pass
            logger.info("Petcam stopped")

    app = FastAPI(title="Petcam", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.hub = hub
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response

    @app.get("/")
    async def root() -> RedirectResponse:
        return RedirectResponse(url="/watch", status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    @app.get("/cam", response_class=HTMLResponse)
    async def cam_page(request: Request) -> Response:
        return templates.TemplateResponse(request, "cam.html")

    @app.get("/watch", response_class=HTMLResponse)
    async def watch_page(request: Request) -> Response:
        return templates.TemplateResponse(request, "watch.html")

    @app.get("/setup", response_class=HTMLResponse)
    async def setup_page(request: Request) -> Response:
        # This page shows both secret keys, so it is only served to a browser
        # running on the server itself (http://127.0.0.1:<port>/setup).
        if not is_local_request(request):
            logger.warning("refused /setup from %s", request.client.host if request.client else "?")
            return templates.TemplateResponse(request, "setup_denied.html", {"port": settings.port},
                                              status_code=status.HTTP_403_FORBIDDEN)
        return templates.TemplateResponse(request, "setup.html", pairing_context(settings))

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse(await hub.health())

    @app.get("/config.json")
    async def client_config() -> JSONResponse:
        return JSONResponse({"stun_enabled": settings.stun_enabled, "ice_servers": settings.ice_servers()})

    @app.get("/qr/watch.svg")
    async def watch_qr(request: Request) -> Response:
        # Lets a phone that already knows the viewer key show a QR code for
        # another phone. The key must be presented, so nothing leaks.
        presented = request.headers.get("x-petcam-key", "")
        if not hmac.compare_digest(presented.encode("utf-8"), settings.viewer_key.encode("utf-8")):
            return Response(status_code=status.HTTP_401_UNAUTHORIZED)
        return Response(qr_svg(settings.watch_pairing_url), media_type="image/svg+xml")

    @app.websocket("/ws/publisher")
    async def publisher_socket(websocket: WebSocket) -> None:
        await run_session(websocket, "publisher", settings, hub, server_tailscale_ip)

    @app.websocket("/ws/viewer")
    async def viewer_socket(websocket: WebSocket) -> None:
        await run_session(websocket, "viewer", settings, hub, server_tailscale_ip)

    return app


def pairing_context(settings: Settings) -> dict[str, str]:
    """Template variables for the pairing page (also used by setup.py)."""
    return {
        "hostname": settings.hostname,
        "cam_url": settings.cam_pairing_url,
        "watch_url": settings.watch_pairing_url,
        "cam_qr_svg": qr_svg(settings.cam_pairing_url),
        "watch_qr_svg": qr_svg(settings.watch_pairing_url),
    }


def _load_settings_or_exit() -> Settings:
    try:
        return load_settings()
    except ConfigError as exc:
        logger.error("Configuration error: %s", exc)
        sys.exit(1)


app = create_app(_load_settings_or_exit())
