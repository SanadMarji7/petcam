# Petcam: vision, current state, and the Phase 1 plan

Last updated: 2026-10-26. Owner: Sanad Marji (SanadMarji7 on GitHub).

## 1. What this is

Petcam started as a personal, self-hosted dog monitor: an old iPad on a stand streams camera and microphone, a Pixel or iPhone watches it live. It is becoming a **commercial product** with the same core and a wider scope:

- Any device can be the camera: old phones and tablets through a web page today, native apps later, and eventually a purpose-built device (camera plus treat or toy dispenser) that accepts commands.
- Several people watch the same camera at once (family members, dog sitter).
- Viewers can talk to the dog (two-way audio).
- Later: recording and clips, motion or bark events, notifications, commands to hardware ("release treat"), accounts and billing.
- The owner also uses it for their own dog and does not want to pay for a camera or an app subscription; the personal setup must stay cheap (one small VPS) and simple.

Non-negotiables for the product: **works out of the box** for non-technical users (no LAN tweaks, no VPN, no router changes), on any current phone browser, from any network including mobile data.

## 2. Where the repo stands today

**Status (2026-10-26): Phase 1 (LiveKit migration, section 4) is in progress / implemented.** The backend mints LiveKit tokens, the pages use the LiveKit browser SDK, and `deploy/` holds the production stack. The description below is the state *before* Phase 1, kept for context.

The pre-Phase-1 code was a working, tested implementation of the original private design:

- `main.py` + `hub.py`: FastAPI signaling relay. One publisher (the camera page) and up to N viewers, authenticated with two shared keys, WebSocket signaling, origin check, heartbeat, security headers, local-only `/setup` pairing page with real QR codes (`qrgen.py`), `/qr/watch.svg` for sharing the viewer link.
- `static/js/cam.js`, `watch.js`, `common.js`: plain-JS WebRTC publisher/viewer with per-viewer `RTCPeerConnection`s, session-tagged offers, ICE restart, watchdogs, screen-off mode, QR key import, on-page diagnostic log.
- `tests/`: 40 pytest tests (config, hub, HTTP + WebSocket server, QR). A Playwright + real Chrome end-to-end harness (fake camera) validated 27 scenarios; the recipe is in the memory notes and in section 7 below.
- `docs/SPEC.md`: the original design brief (private, Tailscale only, no TURN, no accounts). Treat it as history, not as current requirements.

**Why it is being replaced.** Field testing on 2026-10-26 showed that Safari on iOS does not use the Tailscale VPN interface for WebRTC: the iPad only offers its home Wi‑Fi address, its public IPv6 and a NAT'd public IPv4. A phone on mobile data cannot reach any of them without a relay, so the "media over the tailnet, no TURN" premise does not hold on the single most important camera device. Workarounds (Tailscale subnet router on the home machine) exist but require exactly the kind of network setup a product cannot ask of users. On top of that the product needs multi-viewer, two-way audio, recording and device commands, which an SFU gives for free and P2P makes painful.

## 3. Target architecture (decided 2026-10-26)

```
 camera device(s)  ──publish──►  ┌───────────────────────────┐  ◄──subscribe──  viewers (web / native)
 (iPad web page,                 │  LiveKit SFU (self-hosted) │  ──publish mic──► (talk to the dog)
  Android app, Pi device)        │  built-in TURN, data chan. │  ──data──►        (commands: treat, toy)
                                 └─────────────▲─────────────┘
                                               │ tokens, room names
                                 ┌─────────────┴─────────────┐
                                 │  Petcam control plane      │  accounts, cameras, pairing,
                                 │  (FastAPI, this repo)      │  token minting, later: billing,
                                 └───────────────────────────┘  recordings, notifications
```

- **Media server: LiveKit, self-hosted** (open source, single binary, includes TURN, SDKs for web/iOS/Android/Flutter/React Native/Python/Rust/Go, Egress for recording, data channels for commands, E2EE available later if "we cannot see your video" becomes a selling point). The same client code runs against LiveKit Cloud if hosting is ever outsourced.
- **Control plane: this FastAPI app**, repurposed. It no longer relays SDP. It authenticates users/devices, knows which cameras exist and who may view them, and mints short-lived LiveKit access tokens with the right grants.
- **Clients: web first** (installable PWAs for camera and viewer), native apps later when needed (Android screen-off capture, push notifications). iOS will always need the camera device's screen on; the existing screen-off overlay + Guided Access checklist stays the answer.
- **Hardware device (future):** Raspberry Pi class device with camera + servo running the LiveKit Python SDK; joins the camera's room as a participant, receives commands over the data channel.

Rejected: P2P + TURN (one upload per viewer from the camera device, no recording, two-way audio awkward), writing our own SFU, relying on managed per-minute services for always-on use.

## 4. Phase 1 plan: personal MVP on the new architecture

Goal: iPad in Safari at home + Pixel on mobile data anywhere = Live within 5 seconds, several viewers, push-to-talk, QR pairing, no network setup. This is also the owner's permanent personal setup. Estimated effort: about one focused week.

### 4.1 Infrastructure

1. One small VPS (Hetzner CX22 class, ~€5/month), Ubuntu or Fedora, public IPv4 (+IPv6).
2. Domain with two names: `app.<domain>` (control plane + pages) and `lk.<domain>` (LiveKit).
3. Deploy LiveKit with its official generator (`docker run --rm -it -v $PWD:/output livekit/generate`), which produces a docker-compose with LiveKit, Redis and Caddy. Caddy terminates TLS and multiplexes port 443 for LiveKit WSS and TURN/TLS, which is what makes mobile and corporate networks work. Open UDP 50000-60000 (media), TCP 7881 (ICE over TCP), UDP 3478 (TURN).
4. Run the Petcam control plane as a third container (or systemd unit) behind the same Caddy on `app.<domain>`.
5. Secrets: LiveKit API key/secret in `config.toml` (never in git), same for the pairing keys.

**Deployment:** the stack in 4.1 is implemented in `deploy/` (Docker Compose with LiveKit, Redis, Caddy + layer4, and the control plane) with a step-by-step VPS guide in `deploy/DEPLOY.md`. Caddy terminates the app's HTTPS itself (layer4 is only used as a listener wrapper to pass `lk.`/`turn.` through by SNI), so the control plane gets real client addresses and an http-to-https redirect for free. One difference from 4.1: a third DNS name `turn.<domain>` is used for TURN/TLS, because Caddy routes port 443 by SNI and cannot tell TURN from WSS on the same name.

### 4.2 Backend changes (`main.py`, `config.py`)

- Remove: `hub.py`, `/ws/publisher`, `/ws/viewer`, heartbeat watchdog, mDNS rewriting, origin check logic tied to a single hostname (keep a configurable allowed-origins list).
- Add `config.toml` keys: `livekit_url` (wss://lk.<domain>), `livekit_api_key`, `livekit_api_secret`, `public_url`.
- Add `POST /api/token` (JSON `{role: "camera"|"viewer", key, device_id, camera_id?}`):
  - Phase 1 keeps the two shared keys as the auth model (single tenant): `publisher_key` authorizes `role=camera`, `viewer_key` authorizes `role=viewer`. Constant-time comparison, 401 otherwise.
  - Mints a LiveKit `AccessToken` (python package `livekit-api`) with TTL ~1 hour, identity = sanitized device id, room = `cam-<camera_id>` (`default` in phase 1).
  - Grants: camera → `can_publish=True, can_subscribe=True` (hears talk-back), `can_publish_data=True`. viewer → `can_subscribe=True`, `can_publish=True` restricted with `can_publish_sources=["microphone"]`, `can_publish_data=True` (future commands).
  - Returns `{url, token, room}`.
- Keep: `/cam`, `/watch`, `/healthz` (now reports LiveKit reachability via the RoomService API: room exists, participant count), local-only `/setup`, `/qr/watch.svg`, security headers (CSP must allow `connect-src` to `wss://lk.<domain>`), `setup.py` and `qrgen.py` (pairing links become `https://app.<domain>/cam#key=...`).
- Tests: replace hub/WebSocket tests with token endpoint tests (grants, TTL, wrong key, identity sanitization) using the LiveKit token decoder; keep config and QR tests.

### 4.3 Frontend changes (`static/js/*`)

- Vendor `livekit-client` as a self-hosted UMD bundle in `static/js/vendor/` (CSP stays `script-src 'self'`; no bundler needed).
- `common.js`: keep `log`, diagnostics UI, key-in-fragment import, device id, stored key helpers. Drop `SignalingClient`.
- `cam.js`: get key → `POST /api/token` → `room.connect(url, token)` → create local video (H.264 preferred, simulcast on, 720p/15 fps default, "high" layer 30 fps) and audio tracks → publish. Keep: camera fallback ladder, wake lock, screen-off overlay and 60 s auto-off, track-ended recovery (re-acquire and `replaceTrack` via LiveKit's `track.replaceTrack`), status strip (viewer count = remote participants). Remove: per-viewer peer connections, offers, ICE handling. LiveKit reconnects by itself; keep a watchdog that re-connects the room if `ConnectionState` stays disconnected > 20 s.
- `watch.js`: key → token → connect → attach the camera participant's video/audio tracks on `TrackSubscribed`. Keep unmute, fullscreen, quality toggle (map to `setVideoQuality(LOW|HIGH)` on the remote track), Share QR, offline banner (no camera participant in the room). Add **push-to-talk**: hold a button → `localParticipant.setMicrophoneEnabled(true)`, release → `false`. Remove all ICE/offer code and the stall watchdog (use `track.on('videoFrameReceived')`/stats only for the resolution display).
- Templates: add the Talk button to `watch.html`; everything else stays.

### 4.4 Acceptance checklist

- iPad (Safari, home Wi‑Fi) + Pixel (Chrome, mobile data): Live in < 5 s, audio on unmute, talk-back audible on the iPad.
- Three viewers at once (Pixel, iPhone Safari, laptop), camera page still shows 720p/15 fps and stable CPU.
- Pixel switches Wi‑Fi ↔ 5G: video resumes within ~10 s without a tap.
- Camera page runs 12 h in screen-off mode under Guided Access without intervention.
- Server reboot: all clients reconnect by themselves.
- Playwright E2E (see section 7) passes against a local `livekit-server --dev` instance.

### 4.5 Out of scope for phase 1 (phase 2+)

Accounts and sign-in, multiple cameras per account, viewer invites, recording/clips (LiveKit Egress), notifications, motion/bark events, billing, native apps, hardware device, landing page.

## 5. Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-26 | Drop the Tailscale-only P2P design | iOS Safari offers no Tailscale address; mobile-data viewers cannot connect without a relay; product cannot require VPN/LAN setup |
| 2026-10-26 | SFU (LiveKit) instead of P2P + TURN | Multi-viewer, two-way audio, recording and device commands are all native to an SFU; P2P would be rewritten within months |
| 2026-10-26 | Self-host LiveKit, keep the option of LiveKit Cloud | Always-on usage makes per-minute pricing expensive; identical client code either way |
| 2026-10-26 | Web-first clients, native later | Covers every device immediately; native only buys Android screen-off capture and push notifications |
| 2026-10-26 | Keep two shared keys as phase 1 auth | Single-tenant personal MVP; accounts come with phase 2 |

## 6. Things future agents should know

- The owner's test rig: this Fedora laptop was the home server (Tailscale name `p200300e97f287bb8d15d4e3dad93f299.tail21bb24.ts.net`), an iPad in Safari as camera, a Pixel and an iPhone as viewers. `config.toml` (gitignored) holds real keys; never print them.
- iOS facts that will not change: camera capture stops when Safari is backgrounded or the screen locks; Wake Lock needs iOS 16.4+ and a user gesture; `playsinline` + `muted` are required for autoplay; Safari exposes real host IPs only after camera permission is granted and never the VPN interface.
- Chrome facts: host candidates are mDNS-obfuscated (`<uuid>.local`) on pages without camera permission; unmuted autoplay needs a gesture.
- The browser `grep` in this shell is aliased to ugrep (no PCRE lookahead); use `/usr/bin/grep`.
- Keep the diagnostic log (long-press the status strip); it is how field problems get diagnosed.

## 7. End-to-end test recipe (works today, adapt for LiveKit)

Node + `playwright-core` driving the system Google Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`. Two browser contexts (camera with camera/microphone permission, viewer), wait for the camera status "Streaming" and the viewer status "Live", then assert `#feed-stats` matches `/\d+x\d+ @ [1-9]\d*fps/`. Scenarios worth keeping: viewer reload, Reconnect button, camera page reload, camera closes and returns, second viewer, viewer limit, wrong key, offline/online blip, dead video track recovery. QR codes can be verified by screenshotting `/setup` and decoding with OpenCV's `QRCodeDetector`. For LiveKit, run `livekit-server --dev` locally and point `livekit_url` at it.
