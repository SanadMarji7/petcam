from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PUBLISHER_KEY = "test-publisher-key-0123456789abcdefghij"
VIEWER_KEY = "test-viewer-key-0123456789abcdefghijklmn"
HOSTNAME = "dogcam.test.ts.net"

# main.py builds its default app at import time; give it a valid test config.
os.environ.update(
    {
        "PETCAM_CONFIG": str(ROOT / "tests" / "does-not-exist.toml"),
        "PETCAM_HOSTNAME": HOSTNAME,
        "PETCAM_PUBLISHER_KEY": PUBLISHER_KEY,
        "PETCAM_VIEWER_KEY": VIEWER_KEY,
        "PETCAM_MAX_VIEWERS": "2",
        "PETCAM_STUN_ENABLED": "false",
    }
)

from config import Settings  # noqa: E402


@pytest.fixture
def settings() -> Settings:
    return Settings(
        hostname=HOSTNAME,
        publisher_key=PUBLISHER_KEY,
        viewer_key=VIEWER_KEY,
        max_viewers=2,
        stun_enabled=False,
        port=8000,
    )
