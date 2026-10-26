#!/usr/bin/env python3
"""Petcam setup assistant.

Creates config.toml with fresh random keys (or keeps the existing ones),
fills in the server's Tailscale MagicDNS name, prints scannable QR codes in
the terminal and writes pairing.html with the same codes for a browser.

Usage:  python3 setup.py            (inside the project venv)
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import webbrowser
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import (
    BASE_DIR,
    DEFAULT_CONFIG_PATH,
    ConfigError,
    Settings,
    load_settings,
    normalize_hostname,
    render_config,
)
from qrgen import matrix_to_terminal, qr_matrix, qr_svg

PLACEHOLDER_HOST = "dogcam.your-tailnet.ts.net"
PAIRING_FILE = BASE_DIR / "pairing.html"

BOLD = "\033[1m"
GREEN = "\033[1;32m"
YELLOW = "\033[1;33m"
RED = "\033[1;31m"
CYAN = "\033[1;36m"
DIM = "\033[90m"
RESET = "\033[0m"


def tailscale_hostname() -> tuple[str | None, str]:
    """(MagicDNS name, status message) from `tailscale status --json`."""
    try:
        raw = subprocess.check_output(["tailscale", "status", "--json"], text=True, stderr=subprocess.DEVNULL, timeout=10)
    except FileNotFoundError:
        return None, "Tailscale CLI not found. Install it: curl -fsSL https://tailscale.com/install.sh | sh"
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        return None, f"Could not query Tailscale ({exc}). Is tailscaled running?"

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None, "Unexpected output from 'tailscale status --json'"

    state = data.get("BackendState")
    if state != "Running":
        return None, f"Tailscale is '{state}'. Run: sudo tailscale up"

    cert_domains = data.get("CertDomains") or []
    if cert_domains and cert_domains[0]:
        return str(cert_domains[0]).rstrip("."), "ok"
    dns_name = str((data.get("Self") or {}).get("DNSName") or "").rstrip(".")
    if dns_name:
        return dns_name, "ok (enable HTTPS certificates in the Tailscale admin console if not done yet)"
    return None, "Tailscale is running but MagicDNS is off. Enable MagicDNS in the Tailscale admin console."


def existing_settings() -> Settings | None:
    if not DEFAULT_CONFIG_PATH.exists():
        return None
    try:
        return load_settings(DEFAULT_CONFIG_PATH)
    except ConfigError as exc:
        print(f"{YELLOW}[!] Existing config.toml is not usable: {exc}{RESET}")
        return None


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

    host, status = tailscale_hostname()
    if host:
        print(f"{GREEN}[✓] Tailscale name: {host}{RESET}  {DIM}{status}{RESET}")
    else:
        print(f"{YELLOW}[!] Tailscale: {status}{RESET}")

    current = existing_settings()
    if current is not None:
        print(f"{GREEN}[✓] Keeping the keys from config.toml{RESET}")
        publisher_key, viewer_key = current.publisher_key, current.viewer_key
        max_viewers, stun_enabled, port = current.max_viewers, current.stun_enabled, current.port
        hostname = current.hostname
    else:
        print(f"{YELLOW}[*] Creating config.toml with new random keys{RESET}")
        publisher_key, viewer_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        max_viewers, stun_enabled, port = 4, True, 8000
        hostname = PLACEHOLDER_HOST

    if host and host != hostname:
        print(f"{YELLOW}[*] Setting hostname to {host}{RESET}")
        hostname = host
    elif not host and PLACEHOLDER_HOST in hostname:
        typed = input("Tailscale name of this server (e.g. dogcam.tail1234.ts.net), or Enter to skip: ").strip()
        if typed:
            hostname = normalize_hostname(typed)

    settings = Settings(
        hostname=hostname,
        publisher_key=publisher_key,
        viewer_key=viewer_key,
        max_viewers=max_viewers,
        stun_enabled=stun_enabled,
        port=port,
    )
    write_config(settings)
    print(f"{GREEN}[✓] Saved {DEFAULT_CONFIG_PATH}{RESET}")

    if PLACEHOLDER_HOST in settings.hostname:
        print(f"\n{RED}The hostname is still a placeholder, so the QR codes below will not open on your devices.")
        print(f"Run 'sudo tailscale up', enable MagicDNS + HTTPS in the Tailscale admin console, then run setup.py again.{RESET}\n")
        return 1

    pairing = write_pairing_html(settings)
    print(f"\n{BOLD}Pairing page with large QR codes:{RESET} {GREEN}file://{pairing}{RESET}")
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        try:
            webbrowser.open(pairing.as_uri())
        except Exception:
            pass

    for label, url in (("1. iPad — scan with the Camera app, open /cam", settings.cam_pairing_url),
                       ("2. Phone — scan with the camera, open /watch", settings.watch_pairing_url)):
        print(f"\n{YELLOW}{label}{RESET}")
        print(matrix_to_terminal(qr_matrix(url)))
        print(f"{DIM}{url}{RESET}")

    print(f"\n{CYAN}Next steps{RESET}")
    print(f"  1. HTTPS via Tailscale:  {GREEN}sudo tailscale serve --bg {settings.port}{RESET}")
    print(f"  2. Start the server:     {GREEN}uvicorn main:app --host 127.0.0.1 --port {settings.port}{RESET}")
    print(f"     or as a service:      {GREEN}sudo systemctl enable --now dogcam{RESET}")
    print(f"  3. Check it:             {GREEN}curl https://{settings.hostname}/healthz{RESET}")
    print(f"  Pairing page while the server runs: {GREEN}http://127.0.0.1:{settings.port}/setup{RESET} (on this machine only)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
