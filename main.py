"""Petcam control plane.

Serves the two pages (/cam for the camera device, /watch for phones and
laptops) and mints LiveKit access tokens for them. Media and signaling are
handled entirely by the LiveKit server; this process never sees a frame.

Run with:  uvicorn main:app --host 127.0.0.1 --port 8000

Behind a reverse proxy the client address in the log is taken from
X-Forwarded-For when uvicorn trusts the proxy (its default trusts 127.0.0.1;
the Docker image passes --forwarded-allow-ips, see deploy/Dockerfile). Nothing
security-relevant depends on that address: the pairing page (/setup) is
guarded by a per-start token, not by where the request seems to come from,
because a layer-4 proxy makes every request look local.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import secrets
import sys
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Any, AsyncIterator

import aiohttp
from fastapi import FastAPI, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from livekit import api

from config import ConfigError, Settings, load_settings
from qrgen import qr_svg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("petcam")

BASE_DIR = Path(__file__).resolve().parent

TOKEN_TTL = timedelta(hours=1)
LIVEKIT_API_TIMEOUT_SECONDS = 2.0
MAX_BODY_BYTES = 16 * 1024
# A viewer that was just given a token keeps its seat for this long even
# before LiveKit lists it, so two phones asking at the same moment cannot both
# squeeze into the last seat (the room's own participant cap is the backstop).
RECENT_VIEWER_SECONDS = 30.0
ROLES = ("camera", "viewer")
IDENTITY_PREFIX = {"camera": "cam-", "viewer": "viewer-"}


def security_headers(settings: Settings) -> dict[str, str]:
    """Response headers for every route; the CSP names the LiveKit server."""
    lk_ws = settings.livekit_origin
    lk_http = settings.livekit_http_url
    return {
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
            # The LiveKit client opens a WebSocket to the SFU and, on failure,
            # fetches /rtc/validate over plain HTTP(S) to explain why.
            f"connect-src 'self' {lk_ws} {lk_http}; "
            "media-src 'self' blob: mediastream:; "
            # LiveKit may spawn a worker (e.g. for end-to-end encryption or
            # codec checks) from a blob: URL.
            "worker-src 'self' blob:; "
            "manifest-src 'self'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'"
        ),
    }


# ----------------------------------------------------------------- helpers


def client_address(request: Request) -> str:
    return request.client.host if request.client else "?"


async def read_body_limited(request: Request, limit: int = MAX_BODY_BYTES) -> bytes | None:
    """The request body, or None when it is larger than `limit`.

    Starlette's request.body() would buffer everything before we could look at
    the size; this reads chunk by chunk and stops as soon as the limit is
    passed, so an oversized upload never occupies more than one chunk of RAM.
    A Content-Length above the limit is refused before reading anything at all.
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                return None
        except ValueError:
            return None
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def sanitize_device_id(value: object) -> str:
    """Keep [A-Za-z0-9_-] only, at most 64 characters (safe as a LiveKit identity)."""
    text = str(value or "").strip()[:64]
    return "".join(ch for ch in text if ch.isalnum() or ch in "_-")


def identity_for(role: str, device_id: object) -> str:
    """cam-<device> / viewer-<device>; a random suffix when the device id is unusable."""
    return IDENTITY_PREFIX[role] + (sanitize_device_id(device_id) or secrets.token_hex(4))


def mint_token(settings: Settings, role: str, identity: str) -> str:
    """A LiveKit JWT for the single Petcam room, valid for one hour."""
    if role == "camera":
        grants = api.VideoGrants(
            room_join=True,
            room=settings.room_name,
            can_publish=True,
            can_subscribe=True,  # hears talk-back from the viewers
            can_publish_data=True,
        )
    else:
        grants = api.VideoGrants(
            room_join=True,
            room=settings.room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True,
            can_publish_sources=["microphone"],  # push-to-talk only, never video
        )
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(role)
        .with_ttl(TOKEN_TTL)
        .with_grants(grants)
        .to_jwt()
    )


async def list_room_participants(settings: Settings) -> list[api.ParticipantInfo]:
    """Current participants of the Petcam room via the LiveKit RoomService API.

    Raises on any transport or server error (the callers decide what that
    means for them). Tests replace this function to avoid needing a server.
    """
    lkapi = api.LiveKitAPI(
        settings.livekit_http_url,
        settings.livekit_api_key,
        settings.livekit_api_secret,
        timeout=aiohttp.ClientTimeout(total=LIVEKIT_API_TIMEOUT_SECONDS),
        failover=False,
    )
    try:
        response = await asyncio.wait_for(
            lkapi.room.list_participants(api.ListParticipantsRequest(room=settings.room_name)),
            timeout=LIVEKIT_API_TIMEOUT_SECONDS,
        )
    finally:
        await lkapi.aclose()
    return list(response.participants)


async def ensure_room(settings: Settings) -> None:
    """Create the Petcam room with a hard participant cap (idempotent).

    LiveKit auto-creates a room without limits when the first participant
    joins; creating it here first pins max_participants to the camera plus the
    configured viewers, so tokens minted earlier cannot be used to exceed the
    viewer limit. Creating a room that already exists returns it unchanged
    (the cap is re-applied the next time the room empties and goes away).
    Raises on any transport or server error; tests replace this function.
    """
    lkapi = api.LiveKitAPI(
        settings.livekit_http_url,
        settings.livekit_api_key,
        settings.livekit_api_secret,
        timeout=aiohttp.ClientTimeout(total=LIVEKIT_API_TIMEOUT_SECONDS),
        failover=False,
    )
    try:
        await asyncio.wait_for(
            lkapi.room.create_room(
                api.CreateRoomRequest(name=settings.room_name, max_participants=settings.max_viewers + 1),
            ),
            timeout=LIVEKIT_API_TIMEOUT_SECONDS,
        )
    finally:
        await lkapi.aclose()


def is_present(participant: api.ParticipantInfo) -> bool:
    return participant.state != api.ParticipantInfo.State.DISCONNECTED


def viewer_identities(participants: list[api.ParticipantInfo]) -> set[str]:
    return {p.identity for p in participants if is_present(p) and p.identity.startswith(IDENTITY_PREFIX["viewer"])}


def camera_present(participants: list[api.ParticipantInfo]) -> bool:
    return any(is_present(p) and p.identity.startswith(IDENTITY_PREFIX["camera"]) for p in participants)


def parse_token_request(raw: bytes) -> dict[str, str] | None:
    """{"role", "key", "device_id"} from the request body, or None when malformed."""
    if len(raw) > MAX_BODY_BYTES:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    role = data.get("role")
    key = data.get("key")
    device_id = data.get("device_id", "")
    if role not in ROLES or not isinstance(key, str) or not key:
        return None
    if device_id is None:
        device_id = ""
    if not isinstance(device_id, str):
        return None
    return {"role": role, "key": key, "device_id": device_id}


# ---------------------------------------------------------------- app factory


def create_app(settings: Settings) -> FastAPI:
    templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
    headers = security_headers(settings)
    # /setup shows both pairing keys. It is unlocked by this random token,
    # which exists only in memory and in the startup log, never by the client
    # address: behind a layer-4 proxy (deploy/caddy.yaml) every request looks
    # like it comes from the machine itself.
    setup_token = secrets.token_urlsafe(24)
    # Viewer identities that received a token recently: identity -> monotonic deadline.
    recent_viewers: dict[str, float] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info(
            "Petcam starting: hostname=%s livekit=%s room=%s max_viewers=%d port=%d",
            settings.hostname, settings.livekit_url, settings.room_name, settings.max_viewers, settings.port,
        )
        logger.info(
            "Pairing page (both keys as QR codes): /setup?token=%s on this server, "
            "e.g. http://127.0.0.1:%d/setup?token=%s or https://%s/setup?token=%s through the proxy",
            setup_token, settings.port, setup_token, settings.hostname, setup_token,
        )
        try:
            yield
        finally:
            logger.info("Petcam stopped")

    app = FastAPI(title="Petcam", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.setup_token = setup_token
    app.state.recent_viewers = recent_viewers
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

    @app.middleware("http")
    async def add_security_headers(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        for name, value in headers.items():
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
        # Both secret keys are on this page. The link with the token is printed
        # in the server log at startup; without it the page is refused whoever
        # asks, including requests that appear to come from 127.0.0.1.
        presented = request.query_params.get("token", "")
        if not hmac.compare_digest(presented.encode("utf-8"), setup_token.encode("utf-8")):
            logger.warning("refused /setup from %s (missing or wrong token)", client_address(request))
            return templates.TemplateResponse(request, "setup_denied.html", {"port": settings.port},
                                              status_code=status.HTTP_403_FORBIDDEN)
        return templates.TemplateResponse(request, "setup.html", pairing_context(settings))

    @app.post("/api/token")
    async def token(request: Request) -> JSONResponse:
        client_ip = client_address(request)
        raw = await read_body_limited(request)
        if raw is None:
            logger.warning("token request from %s rejected: body larger than %d bytes", client_ip, MAX_BODY_BYTES)
            return JSONResponse({"error": "bad_request"}, status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        parsed = parse_token_request(raw)
        if parsed is None:
            logger.warning("token request from %s rejected: malformed body", client_ip)
            return JSONResponse({"error": "bad_request"}, status_code=status.HTTP_400_BAD_REQUEST)
        role, presented, device_id = parsed["role"], parsed["key"], parsed["device_id"]

        expected = settings.publisher_key if role == "camera" else settings.viewer_key
        if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
            logger.warning("token request from %s rejected: wrong %s key", client_ip, role)
            return JSONResponse({"error": "wrong_key"}, status_code=status.HTTP_401_UNAUTHORIZED)

        identity = identity_for(role, device_id)

        # The room carries its own participant cap (camera + max_viewers) so
        # that the check below cannot be bypassed with tokens minted earlier.
        try:
            await ensure_room(settings)
        except Exception as exc:
            logger.warning("LiveKit API unreachable, could not apply the room participant cap: %s", exc)

        if role == "viewer":
            # Count the other viewers: those LiveKit lists in the room plus
            # those that were handed a token in the last few seconds and may
            # still be joining. A reload or a Wi-Fi/5G switch from the same
            # device keeps its identity and must not be counted against itself.
            now = time.monotonic()
            for stale in [i for i, deadline in recent_viewers.items() if deadline <= now]:
                del recent_viewers[stale]
            try:
                in_room = viewer_identities(await list_room_participants(settings))
            except Exception as exc:
                logger.warning("LiveKit API unreachable, skipping the viewer limit check: %s", exc)
            else:
                others = (in_room | set(recent_viewers)) - {identity}
                if len(others) >= settings.max_viewers:
                    logger.warning("viewer %s rejected: limit reached (%d/%d)", identity, len(others), settings.max_viewers)
                    return JSONResponse({"error": "too_many_viewers"}, status_code=status.HTTP_409_CONFLICT)
            recent_viewers[identity] = now + RECENT_VIEWER_SECONDS

        jwt = mint_token(settings, role, identity)
        logger.info("token issued for %s from %s", identity, client_ip)
        return JSONResponse({
            "url": settings.livekit_url,
            "token": jwt,
            "room": settings.room_name,
            "identity": identity,
            "ttl_seconds": int(TOKEN_TTL.total_seconds()),
        })

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        livekit_ok, camera, viewers = True, False, 0
        try:
            participants = await list_room_participants(settings)
        except Exception as exc:
            logger.warning("healthz: LiveKit API unreachable: %s", exc)
            livekit_ok = False
        else:
            camera = camera_present(participants)
            viewers = len(viewer_identities(participants))
        return JSONResponse({
            "livekit": livekit_ok,
            "camera": camera,
            "viewers": viewers,
            "max_viewers": settings.max_viewers,
            "room": settings.room_name,
        })

    @app.get("/qr/watch.svg")
    async def watch_qr(request: Request) -> Response:
        # Lets a phone that already knows the viewer key show a QR code for
        # another phone. The key must be presented, so nothing leaks.
        presented = request.headers.get("x-petcam-key", "")
        if not hmac.compare_digest(presented.encode("utf-8"), settings.viewer_key.encode("utf-8")):
            return Response(status_code=status.HTTP_401_UNAUTHORIZED)
        return Response(qr_svg(settings.watch_pairing_url), media_type="image/svg+xml")

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
