"""Settings for the Petcam server.

Values come from config.toml next to this file (or $PETCAM_CONFIG) and can be
overridden with PETCAM_* environment variables. Loading fails loudly when a
key is missing or weak: the server must never start with guessable keys.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

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
PLACEHOLDER_MARKERS = ("CHANGE_ME", "PASTE_YOUR", "your-tailnet")
STUN_SERVERS = ("stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302")


class ConfigError(ValueError):
    """Raised when config.toml or the environment is missing or invalid."""


@dataclass(frozen=True)
class Settings:
    hostname: str
    publisher_key: str
    viewer_key: str
    max_viewers: int = 4
    stun_enabled: bool = True
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

    def ice_servers(self) -> list[dict[str, str]]:
        if not self.stun_enabled:
            return []
        return [{"urls": url} for url in STUN_SERVERS]


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _as_int(value: object, name: str) -> int:
    try:
        return int(str(value).strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number (got {value!r})") from exc


def normalize_hostname(raw: str) -> str:
    """Accept 'dogcam.tail1234.ts.net', 'https://dogcam.../' or 'host:8000'."""
    host = raw.strip().lower()
    for scheme in ("https://", "http://"):
        if host.startswith(scheme):
            host = host[len(scheme):]
    return host.split("/", 1)[0].strip()


def _check_key(name: str, key: str) -> None:
    if len(key) < MIN_KEY_LENGTH:
        raise ConfigError(
            f"{name} must be at least {MIN_KEY_LENGTH} characters (got {len(key)}). "
            "Run 'python3 setup.py' or generate one with: "
            "python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    if any(marker in key for marker in PLACEHOLDER_MARKERS):
        raise ConfigError(f"{name} still contains the placeholder value from config.example.toml")


def load_settings(config_path: str | Path | None = None) -> Settings:
    path = Path(config_path or os.environ.get("PETCAM_CONFIG") or DEFAULT_CONFIG_PATH)
    data: dict[str, object] = {}
    if path.exists():
        with open(path, "rb") as fh:
            try:
                data = tomllib.load(fh)
            except tomllib.TOMLDecodeError as exc:
                raise ConfigError(f"{path} is not valid TOML: {exc}") from exc

    def pick(env_name: str, toml_name: str, default: object) -> object:
        env_value = os.environ.get(env_name)
        if env_value is not None:
            return env_value
        return data.get(toml_name, default)

    hostname = normalize_hostname(str(pick("PETCAM_HOSTNAME", "hostname", "")))
    publisher_key = str(pick("PETCAM_PUBLISHER_KEY", "publisher_key", "")).strip()
    viewer_key = str(pick("PETCAM_VIEWER_KEY", "viewer_key", "")).strip()
    max_viewers = _as_int(pick("PETCAM_MAX_VIEWERS", "max_viewers", 4), "max_viewers")
    stun_enabled = _as_bool(pick("PETCAM_STUN_ENABLED", "stun_enabled", True))
    port = _as_int(pick("PETCAM_PORT", "port", 8000), "port")

    if not path.exists() and not (publisher_key and viewer_key):
        raise ConfigError(
            f"No configuration found at {path}. Run 'python3 setup.py' to create it, "
            "or copy config.example.toml to config.toml and fill in the keys."
        )
    if not hostname:
        raise ConfigError("hostname is empty. Set it to your server's Tailscale MagicDNS name.")
    if "your-tailnet" in hostname:
        raise ConfigError("hostname still has the placeholder value. Run 'python3 setup.py' with Tailscale up.")
    _check_key("publisher_key", publisher_key)
    _check_key("viewer_key", viewer_key)
    if publisher_key == viewer_key:
        raise ConfigError("publisher_key and viewer_key must be different")
    if max_viewers < 1:
        raise ConfigError("max_viewers must be at least 1")
    if not 1 <= port <= 65535:
        raise ConfigError("port must be between 1 and 65535")

    return Settings(
        hostname=hostname,
        publisher_key=publisher_key,
        viewer_key=viewer_key,
        max_viewers=max_viewers,
        stun_enabled=stun_enabled,
        port=port,
    )


def render_config(settings: Settings) -> str:
    """config.toml text for the given settings (used by setup.py)."""
    return f"""# Petcam configuration (generated by setup.py)
# Keys are secrets: never commit this file or share it.

# Tailscale MagicDNS name of this server. Browsers must open exactly this host.
hostname = "{settings.hostname}"

# Pairing keys, at least 32 characters each.
publisher_key = "{settings.publisher_key}"
viewer_key = "{settings.viewer_key}"

# How many phones/laptops may watch at the same time.
max_viewers = {settings.max_viewers}

# Also offer Google STUN to the browsers. Keep true unless you want media to
# travel only over Tailscale IPs (then set false).
stun_enabled = {"true" if settings.stun_enabled else "false"}

# Local port for Uvicorn; tailscale serve forwards HTTPS to it.
port = {settings.port}
"""
