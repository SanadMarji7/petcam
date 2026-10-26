"""Settings for the Petcam control plane.

Values come from config.toml next to this file (or $PETCAM_CONFIG) and can be
overridden with PETCAM_* environment variables. Loading fails loudly when a
key is missing or weak: the server must never start with guessable keys or
without a LiveKit server to hand browsers to.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - only for Python 3.9/3.10
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError as exc:
        raise RuntimeError("Python < 3.11 needs the 'tomli' package: pip install tomli") from exc

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = BASE_DIR / "config.toml"
MIN_KEY_LENGTH = 32
# Strings that only ever appear in example/template files, never in real values.
PLACEHOLDER_MARKERS = ("CHANGE_ME", "PASTE_YOUR", "your-tailnet", "<domain>", "your-domain")
DEFAULT_ROOM_NAME = "petcam"

# Every setting, in one place: (env var, toml key). Used by load_settings and
# by tests that need to clear the environment.
ENV_VARS = {
    "hostname": "PETCAM_HOSTNAME",
    "publisher_key": "PETCAM_PUBLISHER_KEY",
    "viewer_key": "PETCAM_VIEWER_KEY",
    "livekit_url": "PETCAM_LIVEKIT_URL",
    "livekit_api_key": "PETCAM_LIVEKIT_API_KEY",
    "livekit_api_secret": "PETCAM_LIVEKIT_API_SECRET",
    "room_name": "PETCAM_ROOM_NAME",
    "max_viewers": "PETCAM_MAX_VIEWERS",
    "port": "PETCAM_PORT",
}


class ConfigError(ValueError):
    """Raised when config.toml or the environment is missing or invalid."""


@dataclass(frozen=True)
class Settings:
    hostname: str
    publisher_key: str
    viewer_key: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    room_name: str = DEFAULT_ROOM_NAME
    max_viewers: int = 4
    port: int = 8000

    @property
    def base_url(self) -> str:
        return f"https://{self.hostname}"

    @property
    def cam_pairing_url(self) -> str:
        # The key travels in the URL fragment: browsers never send fragments
        # to the server, so it does not show up in access logs or proxies.
        return f"{self.base_url}/cam#key={self.publisher_key}"

    @property
    def watch_pairing_url(self) -> str:
        return f"{self.base_url}/watch#key={self.viewer_key}"

    @property
    def livekit_origin(self) -> str:
        """Scheme + host[:port] of the LiveKit server (ws:// or wss://), for CSP."""
        parts = urlsplit(self.livekit_url)
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def livekit_http_url(self) -> str:
        """The LiveKit server's HTTP(S) address: ws -> http, wss -> https.

        The browser talks WebSocket to LiveKit; the server-side API (RoomService)
        is plain HTTP on the same host and port.
        """
        parts = urlsplit(self.livekit_url)
        scheme = "https" if parts.scheme == "wss" else "http"
        return f"{scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def _as_int(value: object, name: str) -> int:
    try:
        return int(str(value).strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number (got {value!r})") from exc


def normalize_hostname(raw: str) -> str:
    """Accept 'app.example.com', 'https://app.example.com/' or 'host:8000'."""
    host = raw.strip().lower()
    for scheme in ("https://", "http://"):
        if host.startswith(scheme):
            host = host[len(scheme):]
    return host.split("/", 1)[0].strip()


def normalize_livekit_url(raw: str) -> str:
    """Accept 'wss://lk.example.com', 'https://lk.example.com/' (mapped to wss) or 'ws://127.0.0.1:7880'."""
    url = raw.strip()
    if url.startswith("https://"):
        url = "wss://" + url[len("https://"):]
    elif url.startswith("http://"):
        url = "ws://" + url[len("http://"):]
    return url.rstrip("/")


def _check_key(name: str, key: str) -> None:
    if len(key) < MIN_KEY_LENGTH:
        raise ConfigError(
            f"{name} must be at least {MIN_KEY_LENGTH} characters (got {len(key)}). "
            "Run 'python3 setup.py' or generate one with: "
            "python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    if any(marker in key for marker in PLACEHOLDER_MARKERS):
        raise ConfigError(f"{name} still contains the placeholder value from config.example.toml")


def _check_livekit_url(url: str) -> None:
    if not url:
        raise ConfigError(
            "livekit_url is empty. Set it to your LiveKit server, e.g. wss://lk.example.com "
            "(or ws://127.0.0.1:7880 for a local dev server)."
        )
    parts = urlsplit(url)
    if parts.scheme not in ("ws", "wss") or not parts.netloc:
        raise ConfigError(f"livekit_url must start with ws:// or wss:// and name a host (got {url!r})")
    if any(marker in url for marker in PLACEHOLDER_MARKERS):
        raise ConfigError("livekit_url still has the placeholder value. Put your real LiveKit address in config.toml.")


def load_settings(config_path: str | Path | None = None) -> Settings:
    path = Path(config_path or os.environ.get("PETCAM_CONFIG") or DEFAULT_CONFIG_PATH)
    data: dict[str, object] = {}
    if path.exists():
        with open(path, "rb") as fh:
            try:
                data = tomllib.load(fh)
            except tomllib.TOMLDecodeError as exc:
                raise ConfigError(f"{path} is not valid TOML: {exc}") from exc

    def pick(name: str, default: object) -> object:
        env_value = os.environ.get(ENV_VARS[name])
        if env_value is not None:
            return env_value
        return data.get(name, default)

    hostname = normalize_hostname(str(pick("hostname", "")))
    publisher_key = str(pick("publisher_key", "")).strip()
    viewer_key = str(pick("viewer_key", "")).strip()
    livekit_url = normalize_livekit_url(str(pick("livekit_url", "")))
    livekit_api_key = str(pick("livekit_api_key", "")).strip()
    livekit_api_secret = str(pick("livekit_api_secret", "")).strip()
    room_name = str(pick("room_name", DEFAULT_ROOM_NAME)).strip()
    max_viewers = _as_int(pick("max_viewers", 4), "max_viewers")
    port = _as_int(pick("port", 8000), "port")

    if not path.exists() and not (publisher_key and viewer_key):
        raise ConfigError(
            f"No configuration found at {path}. Run 'python3 setup.py' to create it, "
            "or copy config.example.toml to config.toml and fill in the keys."
        )
    if not hostname:
        raise ConfigError("hostname is empty. Set it to the public name of this server, e.g. app.example.com.")
    if any(marker in hostname for marker in PLACEHOLDER_MARKERS):
        raise ConfigError("hostname still has the placeholder value. Put your real domain in config.toml.")
    _check_key("publisher_key", publisher_key)
    _check_key("viewer_key", viewer_key)
    if publisher_key == viewer_key:
        raise ConfigError("publisher_key and viewer_key must be different")
    _check_livekit_url(livekit_url)
    if not livekit_api_key or not livekit_api_secret:
        raise ConfigError(
            "livekit_api_key and livekit_api_secret are required. They must match the keys "
            "configured in your LiveKit server (livekit.yaml); the dev server uses devkey / secret."
        )
    if any(marker in livekit_api_key or marker in livekit_api_secret for marker in PLACEHOLDER_MARKERS):
        raise ConfigError("livekit_api_key / livekit_api_secret still contain the placeholder value")
    if not room_name or not all(ch.isalnum() or ch in "_-" for ch in room_name):
        raise ConfigError("room_name must contain only letters, digits, '-' and '_'")
    if max_viewers < 1:
        raise ConfigError("max_viewers must be at least 1")
    if not 1 <= port <= 65535:
        raise ConfigError("port must be between 1 and 65535")

    return Settings(
        hostname=hostname,
        publisher_key=publisher_key,
        viewer_key=viewer_key,
        livekit_url=livekit_url,
        livekit_api_key=livekit_api_key,
        livekit_api_secret=livekit_api_secret,
        room_name=room_name,
        max_viewers=max_viewers,
        port=port,
    )


def render_config(settings: Settings) -> str:
    """config.toml text for the given settings (used by setup.py)."""
    return f"""# Petcam configuration (generated by setup.py)
# Keys are secrets: never commit this file or share it.

# Public name browsers use to open this app, e.g. app.example.com
# (or 127.0.0.1:8000 for local development).
hostname = "{settings.hostname}"

# Pairing keys, at least 32 characters each. The camera device gets the
# publisher key, the people watching get the viewer key.
publisher_key = "{settings.publisher_key}"
viewer_key = "{settings.viewer_key}"

# LiveKit server the browsers connect to (wss://lk.example.com in production,
# ws://127.0.0.1:7880 for a local `livekit-server --dev`) and the API key pair
# from its livekit.yaml.
livekit_url = "{settings.livekit_url}"
livekit_api_key = "{settings.livekit_api_key}"
livekit_api_secret = "{settings.livekit_api_secret}"

# LiveKit room the camera and the viewers meet in.
room_name = "{settings.room_name}"

# How many phones/laptops may watch at the same time.
max_viewers = {settings.max_viewers}

# Local port for Uvicorn; the reverse proxy forwards HTTPS to it.
port = {settings.port}
"""
