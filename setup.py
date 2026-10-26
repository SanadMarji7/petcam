#!/usr/bin/env python3
"""
Petcam Interactive Setup Assistant & QR Code Generator
Automates configuration, generates cryptographic keys, detects Tailscale MagicDNS,
and displays instant scannable QR codes both in your terminal and via an HTML pairing page.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import webbrowser
from pathlib import Path

try:
    import qrcode  # type: ignore[import-not-found]
    HAS_QRCODE_PKG = True
except ImportError:
    HAS_QRCODE_PKG = False


def print_banner() -> None:
    print("\033[1;36m")
    print("=" * 64)
    print("   🐶  PETCAM — SELF-HOSTED WEBRTC DOG MONITOR SETUP WIZARD  🐶")
    print("=" * 64)
    print("\033[0m")


def detect_tailscale_hostname() -> str:
    """Attempts to auto-detect Tailscale MagicDNS name using tailscale CLI."""
    try:
        output = subprocess.check_output(["tailscale", "status", "--json"], text=True, stderr=subprocess.DEVNULL)
        data = json.loads(output)
        self_node = data.get("Self", {})
        dns_name = self_node.get("DNSName", "")
        if dns_name:
            return dns_name.rstrip(".")
    except Exception:
        pass

    try:
        ip = subprocess.check_output(["tailscale", "ip", "-4"], text=True, stderr=subprocess.DEVNULL).strip()
        if ip:
            return f"dogcam.{ip}.ts.net"
    except Exception:
        pass

    return "dogcam.your-tailnet.ts.net"


def render_terminal_half_blocks(matrix: list[list[bool]], border: int = 2) -> None:
    """
    Renders QR code in terminal using Unicode half-block characters (▀, ▄, █, ' ').
    Each character cell encodes two vertical QR modules, ensuring an exact 1:1 square
    module aspect ratio that smartphone camera apps can easily focus on and scan.
    """
    h = len(matrix)
    w = len(matrix[0])
    padded_w = w + (border * 2)

    # ANSI codes: 47 = White Background, 30 = Black Foreground
    colors = "\033[47;30m"
    reset = "\033[0m"

    # Top quiet zone border
    for _ in range((border + 1) // 2):
        print(colors + " " * padded_w + reset)

    # Render pairs of rows
    for y in range(0, h, 2):
        top_row = matrix[y]
        bot_row = matrix[y + 1] if y + 1 < h else [False] * w

        row_str = [colors, " " * border]  # left quiet zone
        for x in range(w):
            top = top_row[x]
            bot = bot_row[x]
            if top and bot:
                row_str.append("█")  # both black
            elif top and not bot:
                row_str.append("▀")  # top black, bottom white
            elif not top and bot:
                row_str.append("▄")  # top white, bottom black
            else:
                row_str.append(" ")  # both white
        row_str.append(" " * border)  # right quiet zone
        row_str.append(reset)
        print("".join(row_str))

    # Bottom quiet zone border
    for _ in range((border + 1) // 2):
        print(colors + " " * padded_w + reset)


def matrix_to_svg(matrix: list[list[bool]]) -> str:
    """Converts a QR matrix to a sharp, standalone SVG string."""
    size = len(matrix)
    rects = []
    for y, row in enumerate(matrix):
        for x, val in enumerate(row):
            if val:
                rects.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#000000"/>')
    content = "".join(rects)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="260" height="260" '
        f'style="background:#fff;border-radius:12px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);">'
        f'<rect width="{size}" height="{size}" fill="#ffffff"/>'
        f"{content}"
        f"</svg>"
    )


def create_standalone_pairing_html(
    hostname: str,
    cam_url: str,
    watch_url: str,
    cam_svg: str,
    watch_svg: str,
) -> Path:
    """Generates a clean local HTML pairing guide with embedded SVG QR codes."""
    html_content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Petcam Pairing Guide</title>
  <style>
    body {{
      background: #0b0f19;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      padding: 32px 16px;
      display: flex;
      justify-content: center;
    }}
    .container {{
      max-width: 860px;
      width: 100%;
    }}
    h1 {{
      text-align: center;
      margin-bottom: 8px;
    }}
    .sub {{
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
      margin-bottom: 32px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 24px;
    }}
    .card {{
      background: #131b2e;
      border: 1px solid #2d3b5d;
      border-radius: 16px;
      padding: 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }}
    .tag {{
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 20px;
      margin-bottom: 12px;
    }}
    .tag-cam {{ background: rgba(59,130,246,0.2); color: #60a5fa; border: 1px solid rgba(59,130,246,0.4); }}
    .tag-watch {{ background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4); }}
    .qr-wrap {{
      margin: 16px 0;
      background: #fff;
      padding: 8px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }}
    .link-box {{
      font-family: monospace;
      font-size: 11px;
      background: #070b12;
      border: 1px solid #1e293b;
      padding: 10px;
      border-radius: 8px;
      word-break: break-all;
      width: 90%;
      color: #38bdf8;
      cursor: pointer;
    }}
    .instructions {{
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.5;
      margin-top: 8px;
    }}
    .checklist {{
      margin-top: 32px;
      background: #131b2e;
      border: 1px solid #2d3b5d;
      border-radius: 16px;
      padding: 24px;
    }}
    .checklist h3 {{ margin-top: 0; }}
    .checklist ul {{
      padding-left: 20px;
      color: #cbd5e1;
      font-size: 13px;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <h1>🐶 Petcam Pairing Guide</h1>
    <p class="sub">Point your camera at the QR code on this screen to pair your devices instantly with zero typing.</p>

    <div class="grid">
      <!-- iPad -->
      <div class="card">
        <span class="tag tag-cam">1. iPad Camera Stream</span>
        <h2>Scan with iPad</h2>
        <div class="qr-wrap">{cam_svg}</div>
        <div class="link-box" onclick="navigator.clipboard.writeText('{cam_url}'); alert('Copied iPad Link!');">
          {cam_url}
        </div>
        <p class="instructions">
          1. Aim default iPad camera at this QR code.<br>
          2. Tap the yellow Safari notification.<br>
          3. Tap <strong>Start Camera</strong> and engage <strong>Guided Access</strong>.
        </p>
      </div>

      <!-- Pixel -->
      <div class="card">
        <span class="tag tag-watch">2. Pixel / Phone Watch</span>
        <h2>Scan with Phone</h2>
        <div class="qr-wrap">{watch_svg}</div>
        <div class="link-box" onclick="navigator.clipboard.writeText('{watch_url}'); alert('Copied Viewer Link!');">
          {watch_url}
        </div>
        <p class="instructions">
          1. Aim phone camera at this QR code.<br>
          2. Tap the notification to watch live.<br>
          3. In Chrome, tap <strong>&quot;Add to Home screen&quot;</strong> for full-screen.
        </p>
      </div>
    </div>

    <div class="checklist">
      <h3>iPad Unattended Checklist (Crucial for 24/7 Running):</h3>
      <ul>
        <li><strong>Wall Power:</strong> Keep iPad plugged into charger on a stand.</li>
        <li><strong>Auto-Lock to Never:</strong> iOS Settings &rarr; Display &rarr; Auto-Lock &rarr; Never.</li>
        <li><strong>Guided Access:</strong> iOS Settings &rarr; Accessibility &rarr; Guided Access &rarr; On. Tap Start Camera, then triple-click side button to lock Safari in place.</li>
        <li><strong>Screen Off Mode:</strong> Tap &quot;Screen Off&quot; to keep screen black while streaming continues.</li>
      </ul>
    </div>
  </div>
</body>
</html>
"""
    pairing_file = Path("pairing.html")
    with open(pairing_file, "w", encoding="utf-8") as f:
        f.write(html_content)
    return pairing_file


def main() -> None:
    print_banner()

    config_path = Path("config.toml")
    detected_host = detect_tailscale_hostname()

    if config_path.exists():
        print("\033[1;32m[✓] Existing config.toml found.\033[0m Loading configuration...")
        import config
        try:
            settings = config.load_settings()
            hostname = settings.hostname
            publisher_key = settings.publisher_key
            viewer_key = settings.viewer_key
        except Exception as e:
            print(f"\033[1;31m[!] Error parsing config.toml: {e}\033[0m")
            return
    else:
        print("\033[1;33m[*] Creating new config.toml with auto-generated secure keys...\033[0m")
        hostname = detected_host
        publisher_key = secrets.token_urlsafe(32)
        viewer_key = secrets.token_urlsafe(32)

        config_content = f"""# Petcam configuration file
# Auto-generated by setup.py

# Tailscale MagicDNS hostname
hostname = "{hostname}"

# Secret keys (32+ characters)
publisher_key = "{publisher_key}"
viewer_key = "{viewer_key}"

# Settings
max_viewers = 4
stun_enabled = false
port = 8000
"""
        with open(config_path, "w", encoding="utf-8") as f:
            f.write(config_content)
        print(f"\033[1;32m[✓] Saved {config_path}\033[0m")

    cam_pairing_url = f"https://{hostname}/cam#key={publisher_key}"
    watch_pairing_url = f"https://{hostname}/watch#key={viewer_key}"

    # Generate QR codes
    cam_matrix: list[list[bool]] = []
    watch_matrix: list[list[bool]] = []

    if HAS_QRCODE_PKG:
        qr_cam = qrcode.QRCode(border=2)
        qr_cam.add_data(cam_pairing_url)
        qr_cam.make(fit=True)
        cam_matrix = qr_cam.get_matrix()

        qr_watch = qrcode.QRCode(border=2)
        qr_watch.add_data(watch_pairing_url)
        qr_watch.make(fit=True)
        watch_matrix = qr_watch.get_matrix()

    # Create standalone pairing.html
    cam_svg = matrix_to_svg(cam_matrix) if cam_matrix else f"<code>{cam_pairing_url}</code>"
    watch_svg = matrix_to_svg(watch_matrix) if watch_matrix else f"<code>{watch_pairing_url}</code>"

    pairing_file = create_standalone_pairing_html(hostname, cam_pairing_url, watch_pairing_url, cam_svg, watch_svg)
    full_pairing_path = pairing_file.resolve()

    print("\n" + "=" * 64)
    print("\033[1;37m🚀 EASIEST WAY TO PAIR: OPEN THE VISUAL GUIDE IN YOUR BROWSER\033[0m")
    print("=" * 64)
    print("A crisp, high-resolution pairing page has been created:")
    print(f"\033[1;32m👉 file://{full_pairing_path}\033[0m")
    print("\033[90m(Open this file in Firefox/Chrome or run 'xdg-open pairing.html' for 100% crystal-clear QR codes)\033[0m\n")

    # Attempt to open pairing.html automatically if in desktop environment
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        try:
            webbrowser.open(f"file://{full_pairing_path}")
            print("\033[1;32m[✓] Opened pairing.html in your default web browser.\033[0m\n")
        except Exception:
            pass

    print("-" * 64)
    print("\033[1;37mTERMINAL QR CODES (COMPACT & SCANNABLE):\033[0m")
    print("-" * 64)

    if cam_matrix:
        print("\n\033[1;33m>>> 1. IPAD SETUP (Scan with iPad Camera App):\033[0m")
        render_terminal_half_blocks(cam_matrix, border=2)
        print(f"\033[1;34mLink:\033[0m {cam_pairing_url}")
        print("→ Tap the yellow Safari notification to pair automatically.\n")

    if watch_matrix:
        print("\n\033[1;33m>>> 2. PIXEL / PHONE SETUP (Scan with Phone Camera):\033[0m")
        render_terminal_half_blocks(watch_matrix, border=2)
        print(f"\033[1;34mLink:\033[0m {watch_pairing_url}")
        print("→ Tap the notification to watch live, then 'Add to Home screen'.\n")

    if not HAS_QRCODE_PKG:
        print("\033[1;33mTip:\033[0m For graphical QR codes in the terminal, run:")
        print("  \033[1;32mpip install qrcode\033[0m\n")

    print("=" * 64)
    print("\033[1;36mNEXT STEPS:\033[0m")
    print(f"1. Start Tailscale HTTPS proxy:")
    print(f"   \033[1;32msudo tailscale serve --bg https / http://127.0.0.1:8000\033[0m")
    print(f"2. Enable Petcam service on boot:")
    print(f"   \033[1;32msudo systemctl enable --now dogcam\033[0m")
    print("=" * 64 + "\n")


if __name__ == "__main__":
    main()
