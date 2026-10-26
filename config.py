from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        raise RuntimeError("tomli is required for Python < 3.11: pip install tomli")


@dataclass(frozen=True)
class Settings:
    hostname: str
    publisher_key: str
    viewer_key: str
    max_viewers: int = 4
    stun_enabled: bool = True
    port: int = 8000


def load_settings(config_path: str | Path = "config.toml") -> Settings:
    path = Path(config_path)
    file_data: dict[str, object] = {}

    if path.exists():
        with open(path, "rb") as f:
            file_data = tomllib.load(f)

    # Allow environment variables to override or provide values
    hostname = os.getenv("PETCAM_HOSTNAME", str(file_data.get("hostname", "127.0.0.1:8000")))
    publisher_key = os.getenv("PETCAM_PUBLISHER_KEY", str(file_data.get("publisher_key", "")))
    viewer_key = os.getenv("PETCAM_VIEWER_KEY", str(file_data.get("viewer_key", "")))

    max_viewers_raw = os.getenv("PETCAM_MAX_VIEWERS", str(file_data.get("max_viewers", 4)))
    try:
        max_viewers = int(max_viewers_raw)
    except ValueError:
        max_viewers = 4

    stun_enabled_raw = os.getenv("PETCAM_STUN_ENABLED")
    if stun_enabled_raw is not None:
        stun_enabled = stun_enabled_raw.lower() in ("true", "1", "yes")
    else:
        stun_enabled = bool(file_data.get("stun_enabled", True))

    port_raw = os.getenv("PETCAM_PORT", str(file_data.get("port", 8000)))
    try:
        port = int(port_raw)
    except ValueError:
        port = 8000

    # Validation: keys must be at least 32 characters for defense in depth
    if len(publisher_key) < 32:
        raise ValueError(
            f"publisher_key must be at least 32 characters long (got {len(publisher_key)}). "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )

    if len(viewer_key) < 32:
        raise ValueError(
            f"viewer_key must be at least 32 characters long (got {len(viewer_key)}). "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )

    if max_viewers < 1:
        raise ValueError("max_viewers must be at least 1")

    return Settings(
        hostname=hostname.strip().lower(),
        publisher_key=publisher_key,
        viewer_key=viewer_key,
        max_viewers=max_viewers,
        stun_enabled=stun_enabled,
        port=port,
    )
