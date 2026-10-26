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
HOSTNAME = "app.petcam.test"
# Same values as the local `livekit-server --dev` container. Tests never talk
# to it: every LiveKit API call is monkeypatched (see test_server.py).
LIVEKIT_URL = "ws://127.0.0.1:7880"
LIVEKIT_API_KEY = "devkey"
LIVEKIT_API_SECRET = "secret"
ROOM_NAME = "petcam"

# main.py builds its default app at import time; give it a valid test config.
os.environ.update(
    {
        "PETCAM_CONFIG": str(ROOT / "tests" / "does-not-exist.toml"),
        "PETCAM_HOSTNAME": HOSTNAME,
        "PETCAM_PUBLISHER_KEY": PUBLISHER_KEY,
        "PETCAM_VIEWER_KEY": VIEWER_KEY,
        "PETCAM_LIVEKIT_URL": LIVEKIT_URL,
        "PETCAM_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
        "PETCAM_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
        "PETCAM_ROOM_NAME": ROOM_NAME,
        "PETCAM_MAX_VIEWERS": "2",
    }
)

from config import Settings  # noqa: E402


def pytest_configure(config: pytest.Config) -> None:
    # The dev server's 6-byte secret makes PyJWT warn on every token; real
    # deployments use long secrets, so the warning is noise here. pytest
    # resets warning filters per test, so register it with pytest itself.
    config.addinivalue_line("filterwarnings", "ignore::jwt.warnings.InsecureKeyLengthWarning")


@pytest.fixture
def settings() -> Settings:
    return Settings(
        hostname=HOSTNAME,
        publisher_key=PUBLISHER_KEY,
        viewer_key=VIEWER_KEY,
        livekit_url=LIVEKIT_URL,
        livekit_api_key=LIVEKIT_API_KEY,
        livekit_api_secret=LIVEKIT_API_SECRET,
        room_name=ROOM_NAME,
        max_viewers=2,
        port=8000,
    )
