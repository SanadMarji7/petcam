from __future__ import annotations

from pathlib import Path

import pytest

from config import ConfigError, Settings, load_settings, normalize_hostname, render_config

GOOD_PUB = "p" * 40
GOOD_VIEW = "v" * 40


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(body, encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("PETCAM_HOSTNAME", "PETCAM_PUBLISHER_KEY", "PETCAM_VIEWER_KEY",
                 "PETCAM_MAX_VIEWERS", "PETCAM_STUN_ENABLED", "PETCAM_PORT", "PETCAM_CONFIG"):
        monkeypatch.delenv(name, raising=False)


def test_loads_a_valid_file(tmp_path: Path) -> None:
    path = write(tmp_path, f'hostname = "Dog.Tail1.ts.net"\npublisher_key = "{GOOD_PUB}"\n'
                           f'viewer_key = "{GOOD_VIEW}"\nmax_viewers = 3\nstun_enabled = false\nport = 9000\n')
    s = load_settings(path)
    assert s.hostname == "dog.tail1.ts.net"
    assert s.max_viewers == 3
    assert s.stun_enabled is False
    assert s.port == 9000
    assert s.ice_servers() == []
    assert s.cam_pairing_url == f"https://dog.tail1.ts.net/cam#key={GOOD_PUB}"


def test_missing_file_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="setup.py"):
        load_settings(tmp_path / "nope.toml")


def test_env_overrides_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = write(tmp_path, f'hostname = "a.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n')
    monkeypatch.setenv("PETCAM_HOSTNAME", "https://b.ts.net/")
    monkeypatch.setenv("PETCAM_STUN_ENABLED", "1")
    s = load_settings(path)
    assert s.hostname == "b.ts.net"
    assert s.stun_enabled is True
    assert len(s.ice_servers()) == 2


@pytest.mark.parametrize(
    "body, message",
    [
        (f'hostname = "a.ts.net"\npublisher_key = "short"\nviewer_key = "{GOOD_VIEW}"\n', "publisher_key must be at least 32"),
        (f'hostname = "a.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "CHANGE_ME_TO_A_RANDOM_32_CHAR_VIEWER_KEY"\n', "placeholder"),
        (f'hostname = "dogcam.your-tailnet.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n', "placeholder"),
        (f'hostname = "a.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_PUB}"\n', "must be different"),
        (f'hostname = "a.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nmax_viewers = 0\n', "max_viewers"),
        (f'hostname = "a.ts.net"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nport = 70000\n', "port"),
        ('hostname = "a.ts.net\n', "not valid TOML"),
    ],
)
def test_rejects_bad_config(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings(write(tmp_path, body))


def test_normalize_hostname() -> None:
    assert normalize_hostname(" HTTPS://Dog.ts.net/cam ") == "dog.ts.net"
    assert normalize_hostname("127.0.0.1:8000") == "127.0.0.1:8000"


def test_render_config_round_trips(tmp_path: Path) -> None:
    original = Settings(hostname="x.ts.net", publisher_key=GOOD_PUB, viewer_key=GOOD_VIEW, max_viewers=5, stun_enabled=False, port=8100)
    path = write(tmp_path, render_config(original))
    assert load_settings(path) == original
