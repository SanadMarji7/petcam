# Petcam

A private dog monitor you host yourself. An old iPad on a stand streams its camera and microphone; your phone (Pixel or iPhone) or laptop watches it live from anywhere, with about half a second of delay.

Nothing is exposed to the internet and nothing goes through a cloud service:

- Every device joins your **Tailscale** network. The server is only reachable from your own devices, and `tailscale serve` gives it a real HTTPS certificate.
- The server is a tiny **signaling relay**. It introduces the iPad to each viewer and then gets out of the way.
- Video and audio flow **directly between the iPad and the phone** over WebRTC, end-to-end encrypted (DTLS-SRTP). Inside the tailnet that path is additionally wrapped in WireGuard.
- Two random **pairing keys** (one for the camera, one for viewers) are required on top of Tailscale, delivered by QR code so nobody types them.

```
   iPad (/cam)  ──── WebRTC video + audio, peer to peer over Tailscale ────  Phone (/watch)
        │                                                                      │
        └────── WSS signaling ──────  home server  ──────  WSS signaling ──────┘
                                   (FastAPI, 127.0.0.1:8000,
                                    HTTPS via tailscale serve)
```

---

## 1. What you need

| Item | Notes |
| --- | --- |
| Always-on Linux box at home | Raspberry Pi 4, mini PC, old laptop. Fedora, Ubuntu, Debian and Raspberry Pi OS all work. |
| iPad | iOS 16.4 or newer, on a stand, plugged into power. |
| Viewer | Pixel or other Android phone (Chrome), iPhone (Safari), or any laptop. Up to 4 at once. |
| Tailscale account | Free. Install the app on the server, the iPad and every viewer; sign in with the **same** account. |

## 2. Install the server

```bash
# Fedora
sudo dnf install -y python3 python3-pip git
# Ubuntu / Debian / Raspberry Pi OS
sudo apt update && sudo apt install -y python3 python3-pip python3-venv git

git clone https://github.com/SanadMarji7/petcam.git
cd petcam
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Python 3.11 or newer is recommended (3.9 and 3.10 work with the extra `tomli` package that `requirements.txt` pulls in automatically).

## 3. Tailscale and HTTPS

On the server:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In the [Tailscale admin console → DNS](https://login.tailscale.com/admin/dns) enable **MagicDNS** and **HTTPS Certificates**. Then tell Tailscale to publish the local server over HTTPS:

```bash
sudo tailscale serve --bg 8000
tailscale serve status      # shows https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:8000
```

That gives you a URL like `https://dogcam.tail1234.ts.net` with a valid Let's Encrypt certificate, reachable only from your tailnet. No router ports are opened and no firewall changes are needed; Uvicorn listens on `127.0.0.1` only.

On the iPad and on every phone: install the Tailscale app from the App Store / Play Store, sign in with the same account, and switch it **on** (iOS asks once to allow adding a VPN configuration).

## 4. Create the config and the QR codes

```bash
source venv/bin/activate
python3 setup.py
```

The assistant:

1. reads your Tailscale MagicDNS name,
2. generates two random 32-character keys and writes `config.toml` (keys are kept if the file already exists),
3. prints two scannable QR codes in the terminal and writes `pairing.html` with large versions of the same codes (opened automatically on a desktop).

Both QR codes contain a secret key. Don't screenshot or forward them.

Manual alternative: `cp config.example.toml config.toml` and fill in `hostname`, `publisher_key` and `viewer_key` (generate keys with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`). The server refuses to start with missing, short or placeholder keys.

## 5. Run it

Quick test in the foreground:

```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

As a service that starts on boot and restarts on failure:

```bash
nano dogcam.service            # set User, Group, WorkingDirectory and the paths to your checkout
sudo cp dogcam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dogcam
sudo journalctl -u dogcam -f   # logs
```

Check from any device on the tailnet:

```bash
curl https://dogcam.tail1234.ts.net/healthz
# {"publisher": false, "viewers": 0, "max_viewers": 4}
```

While the server runs, the pairing page with both QR codes is also available at `http://127.0.0.1:8000/setup`, **on the server machine only**. From another computer, tunnel it with `ssh -L 8000:127.0.0.1:8000 user@server` and open the same address. It is deliberately not served over the tailnet because it shows both keys.

## 6. Pair the iPad (camera)

1. Open the iPad **Camera** app, aim it at the **iPad** QR code and tap the yellow Safari banner. Safari opens `/cam` and stores the key on the iPad.
2. Pick the lens (back camera by default) and tap **Start camera**. Allow camera and microphone.
3. The status bar shows **Streaming**. After 60 seconds without a touch the screen goes black on its own (or tap **Screen off**); the camera keeps streaming underneath. Tap anywhere to bring the controls back.

What keeps it running unattended for days:

- **Settings → Display & Brightness → Auto-Lock → Never.** Turn brightness to minimum.
- **Settings → Accessibility → Guided Access → On**, set a passcode. After the camera is streaming, triple-click the top (or side) button to lock Safari in place so notifications, Siri or a curious dog cannot switch apps.
- Keep it on **wall power**.
- **Never press the power button.** Safari freezes the camera when the screen locks or the tab is in the background; nothing in JavaScript can prevent that. The page detects a frozen camera and re-opens it when it becomes visible again, but it cannot do so while locked.

If a second `/cam` page is ever opened, it takes over and the first one shows "Another camera page took over" instead of fighting for the stream.

## 7. Pair the phone or laptop (viewer)

1. Aim the phone camera at the **Phone** QR code and open the link. The page opens `/watch`, stores the key, and connects. Within a few seconds the status strip says **Live**.
2. **Unmute** to hear audio (browsers require a tap before playing sound).
3. **Quality**: *Auto* is 800 kbps at 15 fps (fine on mobile data); *High* is 2 Mbps at 30 fps for Wi-Fi.
4. Tap the video for full screen. **Reconnect** forces a fresh connection if you ever need it.
5. Make it an app: in Chrome tap ⋮ → **Add to Home screen**; in Safari tap Share → **Add to Home Screen**.
6. To let another phone watch, tap **Share QR** and let it scan your screen (it must also be on your Tailscale account).

Switching between Wi-Fi and 5G, locking the phone, or losing signal for a while is handled automatically: the page notices stalled video, asks the iPad for an ICE restart, and rebuilds the connection from scratch if that fails. After three failures in a row it waits 30 seconds between retries.

The same viewer key works on every viewer device. The server allows `max_viewers` at a time (4 by default).

## 8. How it works and what is secured

- **Signaling** (`/ws/publisher`, `/ws/viewer`): the first message on every socket must carry the right key (constant-time comparison, 5-second deadline). The `Origin` header must match the configured hostname. Wrong keys close the socket with code 4401 and are logged with the source IP. Messages are limited to 64 KB and only a fixed set of fields is relayed.
- **Media** never touches the server. The iPad offers; each viewer answers. Both sides prefer H.264 so the iPad uses its hardware encoder. The browsers' host candidates include the Tailscale IPs, so the direct path works from anywhere the tailnet reaches. With `stun_enabled = true` (default) the Google STUN server is also offered, which helps when a device sits behind an unusual NAT; set it to `false` to keep media strictly on Tailscale addresses. No TURN server is needed or supported.
- **Pairing links** put the key in the URL fragment (`#key=`), which browsers never send to the server, so it does not appear in any log.
- **Headers**: `Cache-Control: no-store`, a strict Content-Security-Policy (same-origin scripts only), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Liveness**: clients ping every 10 s; the server drops anything silent for 30 s. A phone that reconnects (reload, network change) replaces its previous session instead of counting twice.

## 9. Troubleshooting

Long-press the status strip on either page to open the on-page diagnostic log. It shows every signaling step, each ICE candidate's address and type, and the chosen media path ("host 100.x.x.x -> prflx ..."). Those lines answer most questions.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Viewer stuck on **Connecting** / ICE `checking` forever | Tailscale is off on the iPad, the phone or the server | Open the Tailscale app on both devices and make sure it is connected. `tailscale ping <device>` from the server should answer. |
| Viewer shows **Camera offline** | The iPad page is not running | On the iPad open Safari → `/cam` → **Start camera**. Check `curl .../healthz` shows `"publisher": true`. |
| Black or frozen video on the viewer | iPad screen locked or Safari backgrounded | Unlock the iPad, bring Safari to the front, set Auto-Lock to Never and use Guided Access. |
| **Wrong key** on the page | Key changed in `config.toml`, or the wrong QR was scanned | Run `python3 setup.py`, scan the fresh code (or paste the key from `config.toml`). |
| Socket closes with code 1008 / "Origin not allowed" | You opened the page by IP or a different name than `hostname` in `config.toml` | Always use the `https://<name>.ts.net` address. |
| **Viewer limit reached** | More than `max_viewers` phones are watching | Close one, or raise `max_viewers` in `config.toml` and restart the service. |
| Video but no sound | Browser autoplay rules | Tap **Unmute**. |
| `/setup` says "local only" | Opened over the tailnet | Open it on the server (`http://127.0.0.1:8000/setup`) or use `python3 setup.py`. |
| Server will not start: "Configuration error" | Missing or placeholder keys / hostname | Run `python3 setup.py`; the message says exactly which value is wrong. |
| Media path shows `srflx` instead of `host 100.x` | The Tailscale path was not usable, so STUN found another route | Works, but check Tailscale on both devices; set `stun_enabled = false` to force the tailnet. |

After changing `config.toml`, restart the server (`sudo systemctl restart dogcam`).

## 10. Development and tests

```bash
source venv/bin/activate
pip install -r requirements-dev.txt
pytest                       # config, hub, server (HTTP + WebSocket) and QR tests
```

Run a local server without Tailscale for code changes (camera access works on `localhost` / `127.0.0.1` without HTTPS):

```bash
PETCAM_HOSTNAME=localhost PETCAM_PUBLISHER_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
PETCAM_VIEWER_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
PETCAM_CONFIG=/dev/null uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Then open `http://127.0.0.1:8000/cam` and `http://127.0.0.1:8000/watch` in two browser windows and paste the keys. Every `config.toml` value can be overridden with a `PETCAM_*` environment variable; `PETCAM_CONFIG` points at an alternative config file.

## Project layout

| Path | What it is |
| --- | --- |
| `main.py` | FastAPI app: pages, `/healthz`, `/config.json`, local-only `/setup`, WebSocket endpoints, security headers |
| `hub.py` | In-memory state (one publisher, N viewers) and message relay |
| `config.py` | `config.toml` + environment loading and validation |
| `qrgen.py` | QR code rendering (SVG for pages, half-blocks for the terminal) |
| `setup.py` | Setup assistant: keys, hostname, QR codes, `pairing.html` |
| `templates/` | `cam.html` (iPad), `watch.html` (viewers), `setup.html` (pairing page) |
| `static/js/common.js` | Signaling WebSocket client, diagnostic log, stats helpers |
| `static/js/cam.js` | Camera capture, per-viewer peer connections, wake lock, screen-off, publisher watchdog |
| `static/js/watch.js` | Viewer connection, controls, viewer watchdog |
| `dogcam.service` | systemd unit |
| `tests/` | pytest suite |
| `docs/SPEC.md` | The original design brief |
