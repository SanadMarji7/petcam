# Petcam

A pet camera you host yourself. An old iPad on a stand streams its camera and microphone; your phone or laptop watches it live from anywhere, with about half a second of delay, and you can talk back to the dog.

It works from any network (home Wi-Fi, mobile data, an office) without VPNs, router changes or an app store, because video goes through a small media server you run on a cheap VPS:

- **LiveKit** (open source) relays audio and video between the iPad and every viewer. It includes a TURN server, so phones on strict networks still connect, and it carries the viewers' microphones back to the iPad.
- **Petcam** (this repo, a small FastAPI app) serves the two web pages and hands out short-lived LiveKit access tokens to devices that present the right **pairing key**. There are two keys, one for the camera and one for viewers, delivered by QR code so nobody types them.
- **Caddy** gives everything HTTPS certificates and makes it all share port 443.

```
  iPad (/cam)  ──publish video+audio──►  ┌──────────────────┐  ──video+audio──►  phones, laptops (/watch)
               ◄──viewers' voices────── │  LiveKit (lk.<domain>) │  ◄──hold to talk──
                      │                 └────────▲─────────┘            │
                      │ token                    │ API                   │ token
                      └──────────►  Petcam control plane (app.<domain>)  ◄┘
```

---

## 1. What you need

| Item | Notes |
| --- | --- |
| A small VPS | Ubuntu 24.04, public IPv4, 2 GB RAM (Hetzner CX22 class, about 5 EUR/month). |
| A domain | Three names on it: `app.<domain>`, `lk.<domain>`, `turn.<domain>`. |
| iPad (camera) | iOS 16.4 or newer, on a stand, plugged into power. Any phone or tablet with a modern browser works too. |
| Viewers | Pixel or other Android phone (Chrome), iPhone (Safari), or any laptop. Up to 4 at once (configurable). |

## 2. Install the server

Follow **[deploy/DEPLOY.md](deploy/DEPLOY.md)**. It walks through DNS records, the firewall, Docker, one `configure.sh` command that generates the keys, and the first start. In short:

```bash
git clone https://github.com/SanadMarji7/petcam.git /opt/petcam
cd /opt/petcam/deploy
./configure.sh <domain>          # fills in the domain, generates petcam.env with random keys
docker compose up -d --build     # LiveKit, Redis, Caddy, Petcam
curl https://app.<domain>/healthz
# {"livekit": true, "camera": false, "viewers": 0, "max_viewers": 4, "room": "petcam"}
./show-pairing.sh                # prints the two pairing QR codes
```

Both QR codes contain a secret key. Don't screenshot or forward them.

## 3. Pair the iPad (camera)

1. Open the iPad **Camera** app, aim it at the **iPad** QR code and tap the yellow Safari banner. Safari opens `/cam` and stores the key on the iPad.
2. Pick the lens (back camera by default) and tap **Start camera**. Allow camera and microphone.
3. The status bar shows **Streaming**. After 60 seconds without a touch the screen goes black on its own (or tap **Screen off**); the camera keeps streaming underneath. Tap anywhere to bring the controls back.

What keeps it running unattended for days:

- **Settings → Display & Brightness → Auto-Lock → Never.** Turn brightness to minimum.
- **Settings → Accessibility → Guided Access → On**, set a passcode. After the camera is streaming, triple-click the top (or side) button to lock Safari in place so notifications, Siri or a curious dog cannot switch apps.
- Keep it on **wall power**.
- **Add the page to the Home Screen** (Share → **Add to Home Screen**) and start it from there. Safari deletes what an ordinary tab stored, including the camera key, after seven days without a touch on the page; a Home Screen app is exempt. If the key is ever lost, the page shows the key form again: just scan the QR code once more.
- **Never press the power button.** Safari freezes the camera when the screen locks or the tab is in the background; nothing in JavaScript can prevent that. The page detects a frozen camera and re-opens it when it becomes visible again, but it cannot do so while locked.

If the connection drops (Wi-Fi hiccup, server update), the page fetches a fresh token and reconnects on its own, waiting a little longer between each attempt. If the iPad shows **Wrong key**, the keys were regenerated: scan the new code.

## 4. Pair the phone or laptop (viewer)

1. Aim the phone camera at the **Phone** QR code and open the link. The page opens `/watch`, stores the key, and connects. Within a few seconds the status strip says **Live**.
2. **Unmute** to hear audio (browsers require a tap before playing sound).
3. **Talk**: press and hold the **Hold to talk** button (or hold the space bar on a laptop) and speak; release to stop. The iPad plays your voice through its speaker. The first time, the browser asks for microphone permission.
4. **Quality**: *Auto* lets the server pick the best layer for your connection (usually fine on mobile data); *High* forces the sharpest 720p layer.
5. Tap the video for full screen. **Reconnect** forces a fresh connection if you ever need it.
6. Make it an app: in Chrome tap ⋮ → **Add to Home screen**; in Safari tap Share → **Add to Home Screen**. On an iPhone this also keeps the key: Safari forgets what a normal tab stored after seven days without opening the page, and you would have to scan again.
7. To let another phone watch, tap **Share QR** and let it scan your screen.

Switching between Wi-Fi and 5G, locking the phone, or losing signal for a while is handled automatically: LiveKit resumes the stream where it can, and the page rebuilds the connection with a fresh token when it cannot.

The same viewer key works on every viewer device. The server allows `PETCAM_MAX_VIEWERS` at a time (4 by default); the fifth sees **Viewer limit reached**.

## 5. How it works and what is secured

- **Tokens** (`POST /api/token`): a page sends its role (`camera` or `viewer`), its pairing key and a device id. The key is checked in constant time against the matching configured key; a wrong key gets 401 and is logged with the client's address (Caddy passes it on in `X-Forwarded-For`, which uvicorn is told to trust; the key itself is never logged). On success the server mints a LiveKit access token valid for one hour, scoped to the single room: the camera may publish video and audio, viewers may subscribe and publish only their microphone. Pages fetch a new token every time they reconnect.
- **Media** flows through LiveKit over WebRTC (DTLS-SRTP encrypted between each browser and the server). H.264 is preferred so the iPad uses its hardware encoder; the camera sends three sizes at once (simulcast) and LiveKit forwards the one each viewer can take.
- **Firewall-hostile networks**: LiveKit offers media over UDP, over TCP 7881, and as a last resort through its TURN relay on port 443 (TLS), which looks like ordinary HTTPS to a corporate or mobile firewall.
- **Viewer limit**: the server also creates the LiveKit room with a hard participant cap (camera + `PETCAM_MAX_VIEWERS`) and remembers viewers it handed a token to in the last 30 seconds, so neither a burst of simultaneous requests nor tokens minted earlier can seat more viewers than configured.
- **Pairing links** put the key in the URL fragment (`#key=`), which browsers never send to the server, so it does not appear in any access log.
- **Pairing page** (`/setup`, both keys as QR codes) opens only with a random token the server prints in its log at startup, never because a request looks local: behind a proxy every request looks local. Requests without the token get a page explaining `show-pairing.sh` instead.
- **Oversized requests** to `POST /api/token` are refused at 16 KiB without being read into memory (and Caddy caps bodies for `app.<domain>` at 64 KiB before that).
- **Headers**: `Cache-Control: no-store`, a strict Content-Security-Policy (scripts only from the app's own origin, connections only to the app and to `lk.<domain>`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Secrets** live in one file on the server, `deploy/petcam.env`, readable by root only and ignored by git.

## 6. Troubleshooting

Long-press the status strip on either page to open the on-page diagnostic log. It shows every step (token request, room connection, tracks published or subscribed, reconnects) with timestamps. Those lines answer most questions.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Viewer shows **Camera offline** | The iPad page is not streaming | On the iPad open Safari → `/cam` → **Start camera**. `curl https://app.<domain>/healthz` should then show `"camera": true`. |
| Black or frozen video on the viewer | iPad screen locked or Safari backgrounded | Unlock the iPad, bring Safari to the front, set Auto-Lock to Never and use Guided Access. |
| **Wrong key** on a page | Keys were regenerated, or the wrong QR was scanned | Run `./show-pairing.sh` on the server and scan the fresh code. The page forgets a rejected key, so just scan again. |
| The key form appears again after a week | Safari removed the stored key (ordinary tab not opened for seven days) | Scan the QR code again, then add the page to the Home Screen so it does not happen again. |
| `https://app.<domain>/setup` says the page is locked | The link was opened without its token | `docker compose logs petcam \| grep 'Pairing page'` shows the full link; or use `./show-pairing.sh`. |
| **Viewer limit reached** | More than `PETCAM_MAX_VIEWERS` phones are watching | Close one, or raise `PETCAM_MAX_VIEWERS` in `deploy/petcam.env` and run `docker compose up -d`. A phone that reloads does not count twice. |
| Video but no sound | Browser autoplay rules | Tap **Unmute**. |
| Talk is not heard on the iPad | iOS Safari only plays incoming audio after a touch on the page, and only while the page is in the foreground | On the iPad tap the page once (or tap **Start camera** again). If the iPad is in screen-off mode, tap to wake the controls first, then try again. |
| Talk button does nothing on the phone | Microphone permission denied | Reload and tap Allow, or enable the microphone for the site in the browser's settings. |
| Stuck on **Connecting** | The phone cannot reach `lk.<domain>` or no media port is open | Check `/healthz` says `"livekit": true`; make sure UDP 50000-60000, UDP 3478 and TCP 7881 are open on the VPS. The diagnostic log shows which step stalls. |
| `/healthz` says `"livekit": false` | LiveKit container down, or API key mismatch | `docker compose logs livekit`; make sure `PETCAM_LIVEKIT_API_KEY`/`SECRET` and `LIVEKIT_KEYS` in `petcam.env` agree. See [deploy/DEPLOY.md](deploy/DEPLOY.md). |
| Choppy video on mobile data | Not enough bandwidth for the High layer | Switch Quality to **Auto**. |
| Server will not start: "Configuration error" | Missing, short or placeholder keys / hostname | The message names the value. Edit `deploy/petcam.env` and run `docker compose up -d`. |

## 7. Development and tests

The app itself needs only Python; LiveKit runs as a local container in development mode (fixed key `devkey` / secret `secret`, no TLS).

```bash
# LiveKit dev server (podman or docker)
podman run -d --name petcam-lk -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
    livekit/livekit-server --dev --bind 0.0.0.0
# later: podman start petcam-lk   /   podman logs petcam-lk

# App
python3 -m venv venv && source venv/bin/activate
pip install -r requirements-dev.txt
pytest -q tests                  # config, token endpoint, viewer limit, healthz, setup page, QR tests

PETCAM_CONFIG=/dev/null PETCAM_HOSTNAME=localhost \
PETCAM_PUBLISHER_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
PETCAM_VIEWER_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
PETCAM_LIVEKIT_URL=ws://127.0.0.1:7880 PETCAM_LIVEKIT_API_KEY=devkey PETCAM_LIVEKIT_API_SECRET=secret \
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Then open `http://127.0.0.1:8000/cam` and `http://127.0.0.1:8000/watch` in two browser windows and paste the keys (camera access works on `localhost` without HTTPS). The server prints a `Pairing page` line with a link like `http://127.0.0.1:8000/setup?token=...` when it starts; that page shows both QR codes (without the token it is refused, from anywhere). Every setting can be given as a `PETCAM_*` environment variable or in a `config.toml` next to `main.py` (`PETCAM_CONFIG` points at another file); the names are listed in `deploy/petcam.env.example`.

Tests do not need the LiveKit container: calls to the LiveKit API are mocked, and tokens are verified offline with the `livekit-api` package.

End-to-end tests drive real Google Chrome with Node and `playwright-core` (flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`): one browser context runs `/cam` with a fake camera, another runs `/watch`, and the harness waits for **Streaming** and **Live** and checks `#feed-stats` reports a resolution and frame rate. The scenario list is in `docs/VISION_AND_PLAN.md`, section 7.

No build step and no npm in the product: plain HTML, CSS and ES2020 JavaScript. The LiveKit browser SDK is vendored as a single file in `static/js/vendor/`.

## Project layout

| Path | What it is |
| --- | --- |
| `main.py` | FastAPI app: pages, `POST /api/token`, `/healthz`, token-gated `/setup`, `/qr/watch.svg`, security headers |
| `config.py` | `config.toml` + environment loading and validation |
| `qrgen.py` | QR code rendering (SVG for pages, half-blocks for the terminal) |
| `setup.py` | Local setup assistant: keys, QR codes, `pairing.html` |
| `templates/` | `cam.html` (camera), `watch.html` (viewers), `setup.html` (pairing page) |
| `static/js/common.js` | Token requests, stored key and device id, diagnostic log, shared helpers |
| `static/js/cam.js` | Camera capture, LiveKit publishing, wake lock, screen-off, camera watchdog |
| `static/js/watch.js` | Viewer connection, controls, push-to-talk, viewer watchdog |
| `static/js/vendor/` | `livekit-client` browser SDK |
| `deploy/` | Docker Compose stack, Caddy and LiveKit configs, `DEPLOY.md` |
| `tests/` | pytest suite |
| `docs/VISION_AND_PLAN.md` | Where the project is going and why |
| `docs/SPEC.md` | The original design brief (historical) |
