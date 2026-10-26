from __future__ import annotations

import asyncio
import hmac
import json
import logging
import secrets
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncGenerator, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from config import Settings, load_settings

# Configure structured logging with timestamps
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("petcam")

MAX_MESSAGE_BYTES = 64 * 1024  # 64 KB max payload
HEARTBEAT_TIMEOUT_SECONDS = 30.0
HEARTBEAT_CHECK_INTERVAL = 5.0
RELAY_STATS_INTERVAL = 60.0


@dataclass
class Client:
    websocket: WebSocket
    role: str  # "publisher" | "viewer"
    id: str
    ip: str
    connect_time: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.last_heartbeat = time.time()


class Hub:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.lock = asyncio.Lock()
        self.publisher: Optional[Client] = None
        self.viewers: dict[str, Client] = {}
        self.relayed_messages_count: int = 0

    async def get_health(self) -> dict[str, object]:
        async with self.lock:
            return {
                "publisher": self.publisher is not None,
                "viewers": len(self.viewers),
                "max_viewers": self.settings.max_viewers,
            }

    async def set_publisher(self, new_client: Client) -> Optional[Client]:
        old_publisher: Optional[Client] = None
        async with self.lock:
            if self.publisher is not None:
                old_publisher = self.publisher
                logger.info(
                    "[%s:%s] Replacing existing publisher [%s]",
                    new_client.role,
                    new_client.id,
                    old_publisher.id,
                )
            self.publisher = new_client

            # Notify all connected viewers that publisher changed
            for viewer_id, viewer in list(self.viewers.items()):
                try:
                    await viewer.websocket.send_text(json.dumps({"type": "publisher_changed"}))
                except Exception as e:
                    logger.warning("[%s:%s] Failed to send publisher_changed: %s", viewer.role, viewer_id, e)

        return old_publisher

    async def remove_publisher(self, client: Client) -> None:
        async with self.lock:
            if self.publisher is not None and self.publisher.id == client.id:
                self.publisher = None
                logger.info("[%s:%s] Publisher disconnected. Notifying %d viewers", client.role, client.id, len(self.viewers))
                for viewer_id, viewer in list(self.viewers.items()):
                    try:
                        await viewer.websocket.send_text(json.dumps({"type": "publisher_offline"}))
                    except Exception as e:
                        logger.warning("[%s:%s] Failed to send publisher_offline: %s", viewer.role, viewer_id, e)

    async def add_viewer(self, client: Client) -> bool:
        async with self.lock:
            if len(self.viewers) >= self.settings.max_viewers:
                logger.warning(
                    "[%s:%s] Rejected connection: viewer limit reached (%d/%d)",
                    client.role,
                    client.id,
                    len(self.viewers),
                    self.settings.max_viewers,
                )
                return False
            self.viewers[client.id] = client
            logger.info("[%s:%s] Viewer registered (active viewers: %d)", client.role, client.id, len(self.viewers))
            return True

    async def remove_viewer(self, client: Client) -> None:
        async with self.lock:
            removed = self.viewers.pop(client.id, None)
            if removed is not None:
                logger.info("[%s:%s] Viewer disconnected (remaining: %d)", client.role, client.id, len(self.viewers))
                if self.publisher is not None:
                    try:
                        await self.publisher.websocket.send_text(
                            json.dumps({"type": "viewer_left", "viewer_id": client.id})
                        )
                    except Exception as e:
                        logger.warning(
                            "[%s:%s] Failed to notify publisher of viewer_left: %s",
                            client.role,
                            client.id,
                            e,
                        )

    async def forward_to_publisher(self, msg: dict[str, object], source_client: Client) -> None:
        async with self.lock:
            if self.publisher is None:
                return
            try:
                await self.publisher.websocket.send_text(json.dumps(msg))
                self.relayed_messages_count += 1
            except Exception as e:
                logger.warning("[%s:%s] Failed to forward to publisher: %s", source_client.role, source_client.id, e)

    async def forward_to_viewer(self, viewer_id: str, msg: dict[str, object], source_client: Client) -> None:
        async with self.lock:
            viewer = self.viewers.get(viewer_id)
            if viewer is None:
                logger.warning(
                    "[%s:%s] Cannot forward message to unknown viewer [%s]",
                    source_client.role,
                    source_client.id,
                    viewer_id,
                )
                return
            try:
                await viewer.websocket.send_text(json.dumps(msg))
                self.relayed_messages_count += 1
            except Exception as e:
                logger.warning("[%s:%s] Failed forwarding to viewer [%s]: %s", source_client.role, source_client.id, viewer_id, e)


# Global settings and hub (initialized in lifespan)
try:
    settings = load_settings()
except Exception as err:
    logger.warning("Default config.toml not found or invalid: %s. Using default fallback configuration.", err)
    settings = Settings(
        hostname="127.0.0.1:8000",
        publisher_key="0123456789abcdef0123456789abcdef",
        viewer_key="abcdef0123456789abcdef0123456789",
        max_viewers=4,
        stun_enabled=False,
        port=8000,
    )

hub = Hub(settings)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("==================================================")
    logger.info("Petcam WebRTC Dog Monitor starting up")
    logger.info("Configured hostname: %s", settings.hostname)
    logger.info("Max viewers: %d", settings.max_viewers)
    logger.info("STUN fallback enabled: %s", settings.stun_enabled)
    logger.info("Listening target: 127.0.0.1:%d", settings.port)
    logger.info("==================================================")

    # Background task: watchdog for client heartbeats and periodic stats logging
    watchdog_task = asyncio.create_task(run_heartbeat_watchdog(hub))
    yield
    watchdog_task.cancel()
    try:
        await watchdog_task
    except asyncio.CancelledError:
        pass
    logger.info("Petcam server stopped.")


async def run_heartbeat_watchdog(h: Hub) -> None:
    last_stats_log = time.time()
    while True:
        try:
            await asyncio.sleep(HEARTBEAT_CHECK_INTERVAL)
            now = time.time()

            # Check dead clients under lock
            stale_clients: list[Client] = []
            async with h.lock:
                if h.publisher is not None:
                    if now - h.publisher.last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
                        stale_clients.append(h.publisher)

                for viewer in h.viewers.values():
                    if now - viewer.last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
                        stale_clients.append(viewer)

            for client in stale_clients:
                logger.warning(
                    "[%s:%s] Heartbeat timed out (>%.1fs). Closing socket.",
                    client.role,
                    client.id,
                    HEARTBEAT_TIMEOUT_SECONDS,
                )
                try:
                    await client.websocket.close(code=4408, reason="Heartbeat timeout")
                except Exception:
                    pass

            if now - last_stats_log >= RELAY_STATS_INTERVAL:
                async with h.lock:
                    pub_status = "connected" if h.publisher is not None else "offline"
                    v_count = len(h.viewers)
                    relayed = h.relayed_messages_count
                logger.info(
                    "[STATS 60s] Publisher: %s | Active Viewers: %d | Relayed messages: %d",
                    pub_status,
                    v_count,
                    relayed,
                )
                last_stats_log = now
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Watchdog loop encountered error: %s", e)


app = FastAPI(title="Petcam", lifespan=lifespan)

# Mount templates and static directory
templates_dir = Path("templates")
templates_dir.mkdir(parents=True, exist_ok=True)
templates = Jinja2Templates(directory="templates")

static_dir = Path("static")
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def add_security_headers(request: Request, call_next) -> Response:
    response: Response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ws: wss:; "
        "media-src 'self' blob:; "
        "object-src 'none'; "
        "base-uri 'self';"
    )
    return response


def verify_ws_origin(websocket: WebSocket, expected_hostname: str) -> bool:
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # Some native WebSockets don't send Origin; allow
    parsed = urlparse(origin)
    netloc = parsed.netloc.lower()
    expected = expected_hostname.lower()

    # Compare exact hostname or allow localhost/127.0.0.1 during local testing
    if netloc == expected or netloc.split(":")[0] == expected.split(":")[0]:
        return True
    if netloc.startswith("localhost") or netloc.startswith("127.0.0.1"):
        return True

    logger.warning("Rejected WebSocket connection: Origin header '%s' does not match '%s'", origin, expected)
    return False


@app.get("/", response_class=RedirectResponse)
async def root_redirect() -> RedirectResponse:
    return RedirectResponse(url="/watch", status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@app.get("/cam", response_class=HTMLResponse)
async def get_cam_page(request: Request) -> Response:
    return templates.TemplateResponse("cam.html", {"request": request})


@app.get("/watch", response_class=HTMLResponse)
async def get_watch_page(request: Request) -> Response:
    return templates.TemplateResponse("watch.html", {"request": request})


@app.get("/healthz")
async def get_healthz() -> dict[str, object]:
    return await hub.get_health()


@app.get("/config.json")
async def get_client_config() -> dict[str, object]:
    ice_servers: list[dict[str, str]] = []
    if settings.stun_enabled:
        ice_servers.append({"urls": "stun:stun.l.google.com:19302"})
    return {
        "stun_enabled": settings.stun_enabled,
        "ice_servers": ice_servers,
    }


async def perform_auth_handshake(
    websocket: WebSocket, expected_key: str, role: str, client_ip: str
) -> Optional[str]:
    """Waits up to 5 seconds for the auth message and performs constant-time comparison."""
    try:
        raw_msg = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("[%s] Auth handshake timeout from %s", role, client_ip)
        await websocket.close(code=4401, reason="Auth timeout")
        return None
    except Exception as e:
        logger.warning("[%s] Auth receive failed from %s: %s", role, client_ip, e)
        return None

    try:
        data = json.loads(raw_msg)
    except json.JSONDecodeError:
        logger.warning("[%s] Non-JSON auth message from %s", role, client_ip)
        await websocket.close(code=4401, reason="Invalid JSON")
        return None

    if not isinstance(data, dict) or data.get("type") != "auth" or "key" not in data:
        logger.warning("[%s] Invalid auth handshake message structure from %s", role, client_ip)
        await websocket.close(code=4401, reason="Malformed auth message")
        return None

    key = str(data["key"])
    if not hmac.compare_digest(key, expected_key):
        logger.warning("[%s] Invalid key provided from %s", role, client_ip)
        await websocket.close(code=4401, reason="Authentication failed")
        return None

    client_id = secrets.token_hex(4)
    await websocket.send_text(json.dumps({"type": "auth_ok", "id": client_id}))
    logger.info("[%s:%s] Authentication successful from %s", role, client_id, client_ip)
    return client_id


@app.websocket("/ws/publisher")
async def publisher_websocket_endpoint(websocket: WebSocket) -> None:
    client_ip = websocket.client.host if websocket.client else "unknown"
    if not verify_ws_origin(websocket, settings.hostname):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Origin disallowed")
        return

    await websocket.accept()
    client_id = await perform_auth_handshake(websocket, settings.publisher_key, "publisher", client_ip)
    if not client_id:
        return

    client = Client(websocket=websocket, role="publisher", id=client_id, ip=client_ip)
    old_pub = await hub.set_publisher(client)
    if old_pub is not None:
        try:
            await old_pub.websocket.close(code=1000, reason="Replaced by new publisher session")
        except Exception:
            pass

    try:
        while True:
            raw_msg = await websocket.receive_text()
            client.touch()

            if len(raw_msg.encode("utf-8")) > MAX_MESSAGE_BYTES:
                logger.warning("[%s:%s] Dropped message: payload exceeded 64 KB", client.role, client.id)
                continue

            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                logger.warning("[%s:%s] Dropped invalid JSON message", client.role, client.id)
                continue

            if not isinstance(msg, dict) or "type" not in msg:
                logger.warning("[%s:%s] Dropped message without 'type'", client.role, client.id)
                continue

            msg_type = msg["type"]

            if msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
            elif msg_type == "offer":
                # publisher -> server: {type: "offer", viewer_id, sdp}
                viewer_id = str(msg.get("viewer_id", ""))
                sdp = msg.get("sdp")
                if not viewer_id or not sdp:
                    logger.warning("[%s:%s] Offer missing viewer_id or sdp", client.role, client.id)
                    continue
                await hub.forward_to_viewer(viewer_id, {"type": "offer", "sdp": sdp}, client)
            elif msg_type == "ice":
                # publisher -> server: {type: "ice", viewer_id, candidate}
                viewer_id = str(msg.get("viewer_id", ""))
                candidate = msg.get("candidate")
                if not viewer_id:
                    logger.warning("[%s:%s] ICE candidate missing viewer_id", client.role, client.id)
                    continue
                await hub.forward_to_viewer(viewer_id, {"type": "ice", "candidate": candidate}, client)
            else:
                logger.warning("[%s:%s] Unknown message type: '%s'", client.role, client.id, msg_type)

    except WebSocketDisconnect:
        logger.info("[%s:%s] WebSocket disconnected", client.role, client.id)
    except Exception as e:
        logger.warning("[%s:%s] WebSocket exception: %s", client.role, client.id, e)
    finally:
        await hub.remove_publisher(client)


@app.websocket("/ws/viewer")
async def viewer_websocket_endpoint(websocket: WebSocket) -> None:
    client_ip = websocket.client.host if websocket.client else "unknown"
    if not verify_ws_origin(websocket, settings.hostname):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Origin disallowed")
        return

    await websocket.accept()
    client_id = await perform_auth_handshake(websocket, settings.viewer_key, "viewer", client_ip)
    if not client_id:
        return

    client = Client(websocket=websocket, role="viewer", id=client_id, ip=client_ip)
    accepted = await hub.add_viewer(client)
    if not accepted:
        await websocket.send_text(json.dumps({"type": "error", "reason": "too_many_viewers"}))
        await websocket.close(code=4409, reason="Viewer capacity reached")
        return

    try:
        while True:
            raw_msg = await websocket.receive_text()
            client.touch()

            if len(raw_msg.encode("utf-8")) > MAX_MESSAGE_BYTES:
                logger.warning("[%s:%s] Dropped message: payload exceeded 64 KB", client.role, client.id)
                continue

            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                logger.warning("[%s:%s] Dropped invalid JSON message", client.role, client.id)
                continue

            if not isinstance(msg, dict) or "type" not in msg:
                logger.warning("[%s:%s] Dropped message without 'type'", client.role, client.id)
                continue

            msg_type = msg["type"]

            if msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
            elif msg_type == "join":
                # Forward viewer_joined to publisher, and inform viewer of current publisher status
                is_pub_online = hub.publisher is not None
                await websocket.send_text(
                    json.dumps({"type": "publisher_online" if is_pub_online else "publisher_offline"})
                )
                if is_pub_online:
                    await hub.forward_to_publisher({"type": "viewer_joined", "viewer_id": client.id}, client)
            elif msg_type == "answer":
                # viewer -> server: {type: "answer", sdp}
                sdp = msg.get("sdp")
                if not sdp:
                    logger.warning("[%s:%s] Answer missing sdp", client.role, client.id)
                    continue
                await hub.forward_to_publisher({"type": "answer", "viewer_id": client.id, "sdp": sdp}, client)
            elif msg_type == "ice":
                # viewer -> server: {type: "ice", candidate}
                candidate = msg.get("candidate")
                await hub.forward_to_publisher(
                    {"type": "ice", "viewer_id": client.id, "candidate": candidate}, client
                )
            elif msg_type == "restart":
                # viewer requests ICE restart
                await hub.forward_to_publisher({"type": "viewer_restart", "viewer_id": client.id}, client)
            elif msg_type == "quality":
                # viewer requests quality change (auto / high)
                quality = msg.get("quality", "auto")
                await hub.forward_to_publisher(
                    {"type": "viewer_quality", "viewer_id": client.id, "quality": quality}, client
                )
            else:
                logger.warning("[%s:%s] Unknown message type: '%s'", client.role, client.id, msg_type)

    except WebSocketDisconnect:
        logger.info("[%s:%s] Viewer disconnected", client.role, client.id)
    except Exception as e:
        logger.warning("[%s:%s] Viewer exception: %s", client.role, client.id, e)
    finally:
        await hub.remove_viewer(client)
