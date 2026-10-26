from __future__ import annotations

from pathlib import Path

import pytest

from config import ENV_VARS, ConfigError, Settings, load_settings, normalize_hostname, normalize_livekit_url, render_config

GOOD_PUB = "p" * 40
GOOD_VIEW = "v" * 40
LK ='livekit_url = "wss://lk.example.com"\nlivekit_api_key = "APIabc"\nlivekit_api_secret = "supersecret"\n'
BASE = f'hostname = "app.example.com"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n' + LK


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(body, encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(ENV_VARS.values()) + ["PETCAM_CONFIG", "PETCAM_STUN_ENABLED"]:
        monkeypatch.delenv(name, raising=False)


def test_loads_a_valid_file(tmp_path: Path) -> None:
    path = write(tmp_path, f'hostname = "App.Example.com"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n'
                           f'{LK}room_name = "living-room"\nmax_viewers = 3\nport = 9000\n')
    s = load_settings(path)
    assert s.hostname == "app.example.com"
    assert s.livekit_url == "wss://lk.example.com"
    assert s.livekit_api_key == "APIabc"
    assert s.livekit_api_secret == "supersecret"
    assert s.room_name == "living-room"
    assert s.max_viewers == 3
    assert s.port == 9000
    assert s.cam_pairing_url == f"https://app.example.com/cam#key={GOOD_PUB}"
    assert s.watch_pairing_url == f"https://app.example.com/watch#key={GOOD_VIEW}"
    assert not hasattr(s, "stun_enabled")


def test_defaults(tmp_path: Path) -> None:
    s = load_settings(write(tmp_path, BASE))
    assert s.room_name == "petcam"
    assert s.max_viewers == 4
    assert s.port == 8000


def test_livekit_url_forms() -> None:
    common = dict(hostname="a", publisher_key=GOOD_PUB, viewer_key=GOOD_VIEW, livekit_api_key="k", livekit_api_secret="s")
    prod = Settings(livekit_url="wss://lk.example.com", **common)
    assert prod.livekit_origin == "wss://lk.example.com"
    assert prod.livekit_http_url == "https://lk.example.com"
    dev = Settings(livekit_url="ws://127.0.0.1:7880", **common)
    assert dev.livekit_origin == "ws://127.0.0.1:7880"
    assert dev.livekit_http_url == "http://127.0.0.1:7880"
    prefixed = Settings(livekit_url="wss://lk.example.com/livekit", **common)
    assert prefixed.livekit_origin == "wss://lk.example.com"
    assert prefixed.livekit_http_url == "https://lk.example.com/livekit"


def test_missing_file_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="setup.py"):
        load_settings(tmp_path / "nope.toml")


def test_env_overrides_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = write(tmp_path, BASE)
    monkeypatch.setenv("PETCAM_HOSTNAME", "https://b.example.com/")
    monkeypatch.setenv("PETCAM_LIVEKIT_URL", "https://lk2.example.com/")
    monkeypatch.setenv("PETCAM_LIVEKIT_API_KEY", "otherkey")
    monkeypatch.setenv("PETCAM_LIVEKIT_API_SECRET", "othersecret")
    monkeypatch.setenv("PETCAM_ROOM_NAME", "garden")
    monkeypatch.setenv("PETCAM_MAX_VIEWERS", "7")
    s = load_settings(path)
    assert s.hostname == "b.example.com"
    assert s.livekit_url == "wss://lk2.example.com"
    assert s.livekit_api_key == "otherkey"
    assert s.livekit_api_secret == "othersecret"
    assert s.room_name == "garden"
    assert s.max_viewers == 7


def test_env_only_without_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PETCAM_HOSTNAME", "127.0.0.1:8765")
    monkeypatch.setenv("PETCAM_PUBLISHER_KEY", GOOD_PUB)
    monkeypatch.setenv("PETCAM_VIEWER_KEY", GOOD_VIEW)
    monkeypatch.setenv("PETCAM_LIVEKIT_URL", "ws://127.0.0.1:7880")
    monkeypatch.setenv("PETCAM_LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("PETCAM_LIVEKIT_API_SECRET", "secret")
    s = load_settings(tmp_path / "missing.toml")
    assert s.hostname == "127.0.0.1:8765"
    assert s.livekit_http_url == "http://127.0.0.1:7880"


@pytest.mark.parametrize(
    "body, message",
    [
        (f'hostname = "a"\npublisher_key = "short"\nviewer_key = "{GOOD_VIEW}"\n{LK}', "publisher_key must be at least 32"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "CHANGE_ME_TO_A_RANDOM_32_CHAR_VIEWER_KEY"\n{LK}', "placeholder"),
        (f'hostname = "app.<domain>"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n{LK}', "placeholder"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_PUB}"\n{LK}', "must be different"),
        (BASE + "max_viewers = 0\n", "max_viewers"),
        (BASE + "port = 70000\n", "port"),
        (BASE + 'room_name = "no spaces"\n', "room_name"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\n', "livekit_url is empty"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nlivekit_url = "lk.example.com"\n', "ws:// or wss://"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nlivekit_url = "wss://lk.<domain>"\n', "placeholder"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nlivekit_url = "wss://lk.example.com"\n', "livekit_api_key"),
        (f'hostname = "a"\npublisher_key = "{GOOD_PUB}"\nviewer_key = "{GOOD_VIEW}"\nlivekit_url = "wss://lk.example.com"\n'
         'livekit_api_key = "APIabc"\nlivekit_api_secret = "CHANGE_ME"\n', "placeholder"),
        ('hostname = "a\n', "not valid TOML"),
    ],
)
def test_rejects_bad_config(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings(write(tmp_path, body))


def test_normalize_helpers() -> None:
    assert normalize_hostname(" HTTPS://App.Example.com/cam ") == "app.example.com"
    assert normalize_hostname("127.0.0.1:8000") == "127.0.0.1:8000"
    assert normalize_livekit_url(" https://lk.example.com/ ") == "wss://lk.example.com"
    assert normalize_livekit_url("http://127.0.0.1:7880") == "ws://127.0.0.1:7880"
    assert normalize_livekit_url("wss://lk.example.com") == "wss://lk.example.com"


def test_render_config_round_trips(tmp_path: Path) -> None:
    original = Settings(
        hostname="app.example.com", publisher_key=GOOD_PUB, viewer_key=GOOD_VIEW,
        livekit_url="wss://lk.example.com", livekit_api_key="APIabc", livekit_api_secret="supersecret",
        room_name="petcam", max_viewers=5, port=8100,
    )
    path = write(tmp_path, render_config(original))
    assert load_settings(path) == original
    assert "stun" not in render_config(original)
