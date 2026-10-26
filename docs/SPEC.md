# Pet Monitor Spec — Self-Hosted WebRTC Dog Cam

Oct 26, 2026 · @Sanad Marji

## Role and overview

Act as a senior full-stack engineer experienced with WebRTC, asynchronous Python (FastAPI) and dependency-free frontend JavaScript. Generate a complete, working codebase for a self-hosted dog monitor: one iPad streams camera and microphone, and up to 4 phones or laptops (primarily a Google Pixel) watch it live from anywhere.

This is a private two-person home tool, not a product. Every decision should favour fewer moving parts, fewer attack surfaces and unattended reliability over features.

Design principles:

- Private by default: nothing is exposed to the public internet. All access goes over a Tailscale network.
- One publisher (the iPad), many viewers (up to 4 concurrent).
- Self-healing: the iPad and every viewer detect stalled video and recover without a human tapping anything.
- No frameworks, no build step, no database. Python backend plus plain HTML, CSS and JavaScript.
- Full working code for every file. No pseudocode, placeholders or TODOs.

## Network and security architecture

All devices join one Tailscale network; the server never listens on a public interface and no ports are forwarded on the home router.

&#91;embedded content: network layout · 3 parts, 1 media path\]

The server only relays signaling messages. Once a viewer and the iPad have exchanged offers, media flows directly between them over their Tailscale IPs.

Requirements:

1. **Tailscale on every device:** the home server, the iPad, the Pixel and any other viewer. Enable MagicDNS so the server has a stable name such as `dogcam.<tailnet>.ts.net`.
2. **HTTPS via `tailscale serve`:** the server runs `tailscale serve --bg https / http://127.0.0.1:8000`. This provides a real Let's Encrypt certificate, so `getUserMedia` works in Safari with no manual cert install. Uvicorn binds to `127.0.0.1` only, never `0.0.0.0`.
3. **Two shared keys** in a `config.toml` (or environment variables): `PUBLISHER_KEY` and `VIEWER_KEY`, each a random 32-character string. The key is sent as the first WebSocket message and verified with a constant-time comparison before any other message is processed. A wrong or missing key closes the socket with code 4401. This is defense in depth in case a device on the tailnet is lost.
4. **Origin check** on the WebSocket upgrade: reject if the `Origin` header does not match the configured hostname.
5. **Key entry on the pages:** each page asks for its key once and stores it in `localStorage`, so the iPad does not need retyping after a reboot. A "forget key" button clears it.
6. **ICE servers:** `iceServers: []` by default; host candidates on Tailscale IPs connect directly. Google STUN (`stun:stun.l.google.com:19302`) may be included as a fallback behind a config flag, off by default. No TURN server is needed.
7. **No cloudflared, ngrok or port forwarding anywhere** in the code or README.
8. Set `Cache-Control: no-store` and the usual security headers (`X-Content-Type-Options`, `Referrer-Policy`, a strict `Content-Security-Policy` allowing only same-origin scripts) on every response.

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Backend | Python 3.11+, FastAPI, Uvicorn, `websockets` | Full type hints, `asyncio` only, no threads |
| Config | `config.toml` read with `tomllib`, env-var override | Keys, hostname, max viewers, STUN flag |
| Frontend | HTML5, CSS3, ES2020 JavaScript | No frameworks, no bundler, no npm |
| Signaling | WebSocket, JSON messages | One socket per client |
| Media | WebRTC `RTCPeerConnection`, H.264 preferred (hardware encode on iPad) | VP8 as fallback |
| Network | Tailscale + `tailscale serve` | HTTPS, NAT traversal, access control |
| Process | `systemd` unit on the home server | Restart on failure, start on boot |

## Backend (`main.py`)

The backend is a stateless-as-possible signaling relay: it knows who is connected and forwards messages, nothing more.

**Routes**

- `GET /cam` serves the publisher page. `GET /watch` serves the viewer page. `GET /` redirects to `/watch`.
- `GET /static/...` serves CSS and JS.
- `GET /healthz` returns `{"publisher": bool, "viewers": int}` for a quick check from any device.
- `WS /ws/publisher` and `WS /ws/viewer`.

**Authentication handshake**

The first message on every socket must be `{"type": "auth", "key": "..."}` within 5 seconds. Compare with `hmac.compare_digest` against the key for that role. On failure, close with code 4401 and log the source IP. On success, reply `{"type": "auth_ok", "id": "<client id>"}`.

**State** (a single `Hub` class, protected by one `asyncio.Lock`)

- `publisher: Optional[Client]` — at most one. A new publisher connection replaces the old one: close the old socket, then notify every viewer with `{"type": "publisher_changed"}` so they renegotiate.
- `viewers: dict[str, Client]` — keyed by a server-generated `viewer_id` (8 random hex chars). Reject a 5th viewer with close code 4409 and `{"type": "error", "reason": "too_many_viewers"}`.
- `Client` holds the WebSocket, role, id, connect time and the last heartbeat time.

**Message relay** (all JSON, every message carries `type`)

| Direction | Message | Server action |
| --- | --- | --- |
| viewer → server | `{type: "join"}` | Forward `{type: "viewer_joined", viewer_id}` to the publisher |
| publisher → server | `{type: "offer", viewer_id, sdp}` | Forward to that viewer only |
| viewer → server | `{type: "answer", sdp}` | Add `viewer_id`, forward to the publisher |
| either → server | `{type: "ice", candidate, viewer_id?}` | Forward to the other party; server fills `viewer_id` for viewer-originated messages |
| viewer → server | `{type: "restart"}` | Forward `{type: "viewer_restart", viewer_id}` to the publisher, which creates a fresh offer with `iceRestart: true` |
| either → server | `{type: "ping"}` | Reply `{type: "pong"}`; also update last-heartbeat |
| server → viewer | `{type: "publisher_online"}` / `{type: "publisher_offline"}` | Sent on join and whenever publisher state changes |
| server → publisher | `{type: "viewer_left", viewer_id}` | Sent when a viewer socket closes for any reason |

Messages with an unknown `type`, missing fields or over 64 KB are dropped and logged, never relayed. Never relay a viewer's message to another viewer.

**Lifecycle**

- On any socket close or exception, remove the client from state under the lock and notify the other side.
- Server-side heartbeat: if no message (including `ping`) arrives from a client for 30 seconds, close its socket with code 4408. The frontend pings every 10 seconds.
- On startup, log the configured hostname, max viewers and whether STUN is enabled. Never log key values.

**Logging**

Use the standard `logging` module with timestamps. Log at INFO: connect, auth result, join, leave, publisher replaced, relay counts every 60 seconds. Log at WARNING: auth failures, dropped messages, viewer limit hit. Include the client role and id in every line.

## Publisher page `/cam` (iPad)

The iPad page has one job: get the camera running, keep it running unattended for hours, and serve every viewer that joins.

**UI (dark, touch-sized, no scrolling)**

- Key entry field on first load (hidden once stored).
- A single large "Start camera" button. After start it becomes a status bar showing: streaming or not, number of connected viewers, camera resolution and fps, uptime.
- Camera picker (front/back) shown only before start. Default to the back camera (`facingMode: "environment"`).
- Local preview `<video>` with `muted`, `playsinline` and `autoplay` set in HTML (not just JS) so Safari allows autoplay and there is no audio feedback.
- "Screen off" button: covers the page with a fully black full-screen overlay (`#000`, no text, no dim status). Tapping anywhere restores the UI. The stream and wake lock keep running underneath. Automatically enter this mode 60 seconds after the stream starts unless the user has touched the screen.
- A small "Forget key" link in a corner, confirmed with a second tap.

**Capture**

- `getUserMedia({ video: { facingMode, width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 15, max: 30} }, audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } })`.
- If 720p fails, retry at 640x480, then with `video: true`. Show the failure reason in plain words if all attempts fail.
- Request `navigator.wakeLock.request('screen')` after start, and re-request it on `visibilitychange` when the page becomes visible again. Show a visible warning if the wake lock is unavailable.

**Per-viewer peer connections**

- Keep `Map<viewer_id, RTCPeerConnection>`. On `viewer_joined`, create a connection, add the same local tracks, `createOffer`, `setLocalDescription`, send `offer`. On `viewer_left`, close and delete that connection without touching the others.
- On `viewer_restart`, call `createOffer({ iceRestart: true })` on that viewer's connection and resend.
- Prefer H.264 via `RTCRtpTransceiver.setCodecPreferences` where supported, so the iPad uses its hardware encoder.
- After adding the video track, call `sender.setParameters` with `encodings: [{ maxBitrate: 800_000, maxFramerate: 15 }]`. Viewers may request `high` quality (2 Mbps, 30 fps) with a message; apply it per sender.
- Trickle ICE: send each `onicecandidate` as it arrives, tagged with `viewer_id`.

**Publisher watchdog**

- Every 5 seconds, check `track.readyState` for both tracks and `getStats()` for `framesEncoded` on the video sender. If a track has ended, or `framesEncoded` has not increased for 15 seconds while at least one viewer is connected, stop all tracks, re-acquire the camera, replace the tracks on every connection with `sender.replaceTrack`, and if that fails, close all connections and re-offer to every known viewer.
- On `visibilitychange` to visible (after Safari backgrounded the page), run the same recovery immediately.
- If the WebSocket drops, reconnect with exponential backoff (1 s, 2 s, 4 s, up to 30 s, with jitter). After reconnecting and re-authenticating, existing peer connections stay open; the server will send `viewer_joined` again for any viewer that reconnects.

**Safari-specific notes to encode in comments and the README**

- Safari suspends `getUserMedia` when the tab is backgrounded or the screen locks; nothing in JavaScript can prevent this. The README's iPad checklist is the real mitigation.
- `wakeLock` requires iOS 16.4+ and a user gesture; request it inside the Start button handler.
- Safari needs `playsinline` and `muted` on the preview element or the video stays black.

## Viewer page `/watch` (Pixel and other devices)

The viewer page opens, connects, and shows the dog within a few seconds, and recovers on its own when the phone changes networks.

**UI (dark, portrait and landscape)**

- Key entry field on first load (hidden once stored).
- Full-width `<video>` with `autoplay`, `playsinline` and `muted` set initially (Chrome blocks unmuted autoplay). Tap the video to toggle fullscreen; double-tap is ignored.
- A bottom bar with: a mute/unmute button (unmuting is a user gesture, so audio plays), a quality toggle (`Auto` 800 kbps / `High` 2 Mbps), and a "Reconnect" button.
- A one-line status strip: `Connecting`, `Live`, `Reconnecting`, `Camera offline`, or `Error: <reason>`. Also show the current ICE state in small text (`new`, `checking`, `connected`, `disconnected`, `failed`) and the incoming resolution and fps from `getStats()`.
- When the publisher is offline, show a centred message "Camera is offline" and keep listening; the page connects automatically when `publisher_online` arrives.
- Add a web app manifest and `theme-color` so "Add to Home Screen" on the Pixel gives a full-screen icon. No service worker.

**Connection flow**

1. Open the WebSocket, send `auth`, wait for `auth_ok`, send `join`.
2. On `offer`: create one `RTCPeerConnection`, `setRemoteDescription`, `createAnswer`, `setLocalDescription`, send `answer`. Attach incoming tracks to the video element in `ontrack`.
3. Send ICE candidates as they arrive; buffer remote candidates that arrive before the remote description is set and apply them afterwards.
4. On `publisher_changed` or `publisher_offline`, close the peer connection and wait for the next `offer`.

**Viewer watchdog**

- Poll `getStats()` every 2 seconds and track `framesDecoded`. If it has not increased for 8 seconds while the status is `Live`, send `restart` (the publisher does an ICE restart). If frames are still stuck 10 seconds later, close the connection, send `join` again and rebuild from a fresh offer. After 3 consecutive failures, back off to a retry every 30 seconds and show `Reconnecting` with a countdown.
- Treat ICE state `failed` the same as stuck frames. Treat `disconnected` as a 5-second grace period before acting.
- On `online` and `visibilitychange` to visible (phone woke up or switched from Wi-Fi to mobile data), run the restart immediately rather than waiting for the watchdog.
- Reconnect the WebSocket with the same exponential backoff as the publisher; after re-auth, send `join` again.

**Multiple viewers**

Each device is independent. Opening `/watch` on a laptop while the Pixel is watching creates a second peer connection on the iPad; closing either does not affect the other. The `/healthz` count on the server reflects both.

## WebRTC negotiation and shared rules

The publisher always offers and the viewer always answers; this keeps the iPad in control of its tracks and makes ICE restarts one-directional.

- `RTCPeerConnection` config: `{ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" }`. If `stun_enabled` is true in config, the server exposes it at `GET /config.json` and both pages add the Google STUN entry.
- Publisher adds tracks with `addTransceiver(track, { direction: "sendonly" })`; viewer transceivers are `recvonly`. No data channels.
- Audio is one-way (iPad to viewer). The viewer never requests microphone access.
- Handle `onnegotiationneeded` on the publisher with a per-connection `makingOffer` flag so a stray event cannot double-offer during an ICE restart.
- Both sides clean up on close: stop stats polling, clear timers, `pc.close()`, null the reference. Never leave an orphaned connection that keeps the camera light on.
- Shared JavaScript (`static/js/common.js`): the WebSocket wrapper with auth, backoff and heartbeat; a `log()` helper that writes to the console and to a hidden on-page log reachable by long-pressing the status strip; and the `getStats()` reader. Both pages import it with a plain `<script>` tag, no modules bundling.

**Bitrate and quality**

| Mode | Resolution | fps | Max bitrate | When |
| --- | --- | --- | --- | --- |
| Auto (default) | 1280x720 | 15 | 800 kbps | Mobile data, battery saving |
| High | 1280x720 | 30 | 2 Mbps | Viewer taps High on Wi-Fi |

The publisher applies the mode per sender, so one viewer in High does not change the others.

## Project file structure

Produce every file below in full.

| File | Contents |
| --- | --- |
| `main.py` | FastAPI app, `Hub` state class, auth handshake, WebSocket relay, security headers, logging |
| `config.py` | Loads `config.toml`, applies env-var overrides, validates key length, exposes a typed `Settings` dataclass |
| `config.example.toml` | `hostname`, `publisher_key`, `viewer_key`, `max_viewers = 4`, `stun_enabled = false`, `port = 8000` |
| `templates/cam.html` | Publisher page skeleton |
| `templates/watch.html` | Viewer page skeleton, manifest link, theme colour |
| `static/manifest.webmanifest` | Name, icons, `display: standalone`, dark background |
| `static/css/styles.css` | Shared dark theme, video container, bottom bar, black overlay, status strip |
| `static/js/common.js` | Signaling WebSocket wrapper, backoff, heartbeat, stats reader, on-page log |
| `static/js/cam.js` | Capture, per-viewer connection map, wake lock, screen-off overlay, publisher watchdog |
| `static/js/watch.js` | Viewer connection, controls, viewer watchdog |
| `dogcam.service` | `systemd` unit: runs Uvicorn on `127.0.0.1:8000`, `Restart=always`, after `tailscaled` |
| `requirements.txt` | `fastapi`, `uvicorn[standard]`, `jinja2` with pinned versions |
| `README.md` | Everything in the next section |

## README requirements

The README is written for someone setting this up once on a weekend, in this order.

1. **What you need:** an always-on machine at home (Raspberry Pi 4, mini PC or old laptop running Linux), an iPad with a stand and charger, a Tailscale account.
2. **Install the server:** clone, create a venv, `pip install -r requirements.txt`, copy `config.example.toml` to `config.toml`, generate two keys with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
3. **Tailscale:** install on the server, run `tailscale up`, enable MagicDNS and HTTPS certificates in the admin console, then `tailscale serve --bg https / http://127.0.0.1:8000`. Install Tailscale on the iPad and Pixel and sign in with the same account. Mention that the Tailscale iOS app must be toggled on and may need "Allow VPN" in Settings.
4. **Run as a service:** install `dogcam.service`, `systemctl enable --now dogcam`, check `journalctl -u dogcam -f` and `curl https://dogcam.<tailnet>.ts.net/healthz`.
5. **iPad setup checklist** (this is what actually keeps it running):
   - Plug it in and put it on a stand aimed at the dog's usual spot.
   - Settings → Display → Auto-Lock → Never. Brightness to minimum.
   - Settings → Accessibility → Guided Access → on; then open Safari to `/cam`, tap Start, allow camera and microphone, triple-click the side button to start Guided Access so Safari cannot be closed or switched away from.
   - Tap "Screen off" or wait 60 seconds for it to go black on its own.
   - Do not lock the screen; Guided Access with Auto-Lock off keeps it awake.
6. **Pixel setup:** open `/watch` in Chrome, enter the viewer key, tap the menu and "Add to Home screen". Check that Tailscale is connected before blaming the app.
7. **Troubleshooting table:** black video (iPad screen locked or Safari backgrounded), `checking` forever (Tailscale off on one device), `Camera offline` (iPad lost Wi-Fi or Safari was closed), auth closed (wrong key, hostname mismatch), no audio (tap unmute).
8. **Optional local-only dev:** run `uvicorn main:app --reload` and open `https://localhost:8000` with `mkcert`; keep this short and clearly marked as development only.

Do not include cloudflared, ngrok, port forwarding or any cloud relay instructions.

## Code quality and non-goals

**Quality requirements**

- Python: full type hints, `from __future__ import annotations`, dataclasses for state, passes `ruff` and `mypy --strict`. No global mutable state outside the `Hub` instance.
- JavaScript: `'use strict'`, `const`/`let` only, `async`/`await` with `try/catch` around every `getUserMedia`, `setLocalDescription`, `setRemoteDescription`, `addIceCandidate` and WebSocket send. Every timer is tracked and cleared on teardown.
- Every file is complete and copy-pasteable. No `// ...`, no `TODO`, no "implement similarly".
- Comments explain the *why* for every Safari or Chrome workaround, with the browser version it applies to.
- Error messages shown on screen are plain English a non-developer can act on ("Camera permission denied. Reload and tap Allow.").

**Explicit non-goals (do not build these)**

- Recording, snapshots, motion detection, bark alerts, two-way talk, treat dispensing.
- User accounts, sign-up, password reset, sessions beyond the two shared keys.
- An SFU, TURN server, Docker Compose stack or Kubernetes manifests.
- A build pipeline, TypeScript, bundler or any npm dependency.
- Public internet exposure of any kind.

**Deliverable**

Generate the complete codebase now, file by file in the order listed in the project structure, each file in its own fenced block with its path as the first line.
