#!/usr/bin/env python3
"""Petcam setup assistant.

Creates config.toml with fresh random pairing keys (or keeps the existing
ones), asks for the public hostname and the LiveKit server details, prints
scannable QR codes in the terminal and writes pairing.html with the same codes
for a browser.

Usage:  python3 setup.py            (inside the project venv)

Non-interactive use: set PETCAM_HOSTNAME, PETCAM_LIVEKIT_URL,
PETCAM_LIVEKIT_API_KEY and PETCAM_LIVEKIT_API_SECRET in the environment and
every question is answered from there.
"""
from __future__ import annotations

import os
import secrets
import sys
import webbrowser
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import (
    BASE_DIR,
    DEFAULT_CONFIG_PATH,
    DEFAULT_ROOM_NAME,
    PLACEHOLDER_MARKERS,
    ConfigError,
    Settings,
    load_settings,
    normalize_hostname,
    normalize_livekit_url,
    render_config,
)
from qrgen import matrix_to_terminal, qr_matrix, qr_svg

PLACEHOLDER_HOST = "app.<domain>"
PAIRING_FILE = BASE_DIR / "pairing.html"

BOLD = "\033[1m"
GREEN = "\033[1;32m"
YELLOW = "\033[1;33m"
RED = "\033[1;31m"
CYAN = "\033[1;36m"
DIM = "\033[90m"
RESET = "\033[0m"


def is_placeholder(value: str) -> bool:
    return not value or any(marker in value for marker in PLACEHOLDER_MARKERS)


def existing_settings() -> Settings | None:
    if not DEFAULT_CONFIG_PATH.exists():
        return None
    try:
        return load_settings(DEFAULT_CONFIG_PATH)
    except ConfigError as exc:
        print(f"{YELLOW}[!] Existing config.toml is not usable: {exc}{RESET}")
        return None


def ask(question: str, env_name: str, current: str) -> str:
    """Environment variable first, then the current value, then the keyboard."""
    from_env = os.environ.get(env_name, "").strip()
    if from_env:
        return from_env
    if not sys.stdin.isatty():
        return current
    hint = f" [{current}]" if current and not is_placeholder(current) else ""
    typed = input(f"{question}{hint}: ").strip()
    return typed or current


def write_config(settings: Settings) -> None:
    DEFAULT_CONFIG_PATH.write_text(render_config(settings), encoding="utf-8")
    try:
        os.chmod(DEFAULT_CONFIG_PATH, 0o600)  # keys are secrets
    except OSError:
        pass


def write_pairing_html(settings: Settings) -> Path:
    env = Environment(loader=FileSystemLoader(str(BASE_DIR / "templates")), autoescape=select_autoescape(["html"]))
    html = env.get_template("setup.html").render(
        hostname=settings.hostname,
        cam_url=settings.cam_pairing_url,
        watch_url=settings.watch_pairing_url,
        cam_qr_svg=qr_svg(settings.cam_pairing_url),
        watch_qr_svg=qr_svg(settings.watch_pairing_url),
    )
    PAIRING_FILE.write_text(html, encoding="utf-8")
    try:
        os.chmod(PAIRING_FILE, 0o600)
    except OSError:
        pass
    return PAIRING_FILE


def main() -> int:
    print(f"{CYAN}{'=' * 64}\n   🐶  Petcam setup\n{'=' * 64}{RESET}")

    current = existing_settings()
    if current is not None:
        print(f"{GREEN}[✓] Keeping the keys from config.toml{RESET}")
        publisher_key, viewer_key = current.publisher_key, current.viewer_key
        hostname, livekit_url = current.hostname, current.livekit_url
        livekit_api_key, livekit_api_secret = current.livekit_api_key, current.livekit_api_secret
        room_name, max_viewers, port = current.room_name, current.max_viewers, current.port
    else:
        print(f"{YELLOW}[*] Creating config.toml with new random keys{RESET}")
        publisher_key, viewer_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        hostname, livekit_url = PLACEHOLDER_HOST, ""
        # A fresh LiveKit API key pair. Copy both into the LiveKit server's
        # livekit.yaml (deploy/livekit.yaml) so the two sides agree.
        livekit_api_key, livekit_api_secret = "API" + secrets.token_hex(6), secrets.token_urlsafe(32)
        room_name, max_viewers, port = DEFAULT_ROOM_NAME, 4, 8000

    hostname = normalize_hostname(ask("Public hostname of this app (e.g. app.example.com)", "PETCAM_HOSTNAME", hostname))
    domain = hostname.split(".", 1)[1] if "." in hostname and not is_placeholder(hostname) else ""
    suggested_lk = livekit_url or (f"wss://lk.{domain}" if domain else "")
    livekit_url = normalize_livekit_url(
        ask("LiveKit server URL (e.g. wss://lk.example.com, or ws://127.0.0.1:7880 for dev)", "PETCAM_LIVEKIT_URL", suggested_lk)
    )
    livekit_api_key = ask("LiveKit API key (must match livekit.yaml)", "PETCAM_LIVEKIT_API_KEY", livekit_api_key)
    livekit_api_secret = ask("LiveKit API secret (must match livekit.yaml)", "PETCAM_LIVEKIT_API_SECRET", livekit_api_secret)

    settings = Settings(
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
    write_config(settings)
    print(f"{GREEN}[✓] Saved {DEFAULT_CONFIG_PATH}{RESET}")

    if is_placeholder(settings.hostname) or is_placeholder(settings.livekit_url):
        print(f"\n{RED}The hostname or the LiveKit URL is still missing, so the server will refuse to start")
        print(f"and the QR codes would not open on your devices. Edit config.toml or run setup.py again.{RESET}\n")
        return 1

    pairing = write_pairing_html(settings)
    print(f"\n{BOLD}Pairing page with large QR codes:{RESET} {GREEN}file://{pairing}{RESET}")
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        try:
            webbrowser.open(pairing.as_uri())
        except Exception:
            pass

    for label, url in (("1. Camera device — scan with the Camera app, open /cam", settings.cam_pairing_url),
                       ("2. Phone — scan with the camera, open /watch", settings.watch_pairing_url)):
        print(f"\n{YELLOW}{label}{RESET}")
        print(matrix_to_terminal(qr_matrix(url)))
        print(f"{DIM}{url}{RESET}")

    print(f"\n{CYAN}Next steps{RESET}")
    print(f"  1. LiveKit keys: make sure livekit.yaml lists  {GREEN}{settings.livekit_api_key}: <the secret from config.toml>{RESET}")
    print(f"  2. Start the server:     {GREEN}uvicorn main:app --host 127.0.0.1 --port {settings.port}{RESET}")
    print("     (or docker compose up -d in deploy/, see deploy/DEPLOY.md)")
    print(f"  3. Check it:             {GREEN}curl https://{settings.hostname}/healthz{RESET}  (\"livekit\": true)")
    print(f"  Pairing page while the server runs: {GREEN}http://127.0.0.1:{settings.port}/setup?token=...{RESET}")
    print("     (the full link, with the token, is in the server log at startup: look for \"Pairing page\")\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
