# Petcam (agent notes)

Read `docs/VISION_AND_PLAN.md` first. It explains what this project is, where it is going, and why. `docs/SPEC.md` is the original brief and is partly obsolete.

## In one paragraph

Self-hosted pet camera: a camera device (an iPad in Safari today) streams video and audio, phones and laptops watch live. Started as a private Tailscale-only P2P tool; now being turned into a commercial product on a LiveKit SFU with this FastAPI app as the control plane (accounts, pairing, token minting). Must work out of the box for non-technical users on any device and any network.

## Current code (Phase 1: LiveKit, working and tested end to end)

- `main.py` control plane: pages, `POST /api/token` (mints LiveKit JWTs; 401 `wrong_key`, 409 `too_many_viewers`), `/healthz` (asks LiveKit's RoomService who is in the room), `/setup` (both keys; opens only with the random token logged at startup, never by client address, because the proxy makes everything look local), `/qr/watch.svg`, security headers/CSP. Every token request also creates the LiveKit room with `max_participants = max_viewers + 1` and viewers handed a token in the last 30 s count towards the limit. No WebSockets, no media: LiveKit does signaling and relaying.
- `config.py` settings (`config.toml` + `PETCAM_*` env; `livekit_url`, `livekit_api_key`, `livekit_api_secret`, `room_name`, ...), `qrgen.py` QR codes, `setup.py` setup assistant.
- `templates/` (`cam.html`, `watch.html`, `setup.html`, `setup_denied.html`), `static/js/` (`common.js` shared helpers + `requestToken`, `cam.js` camera page, `watch.js` viewer page with push-to-talk), `static/js/vendor/livekit-client.umd.js` (livekit-client 2.23.0, global `LivekitClient`), `static/css/styles.css`.
- `deploy/` docker-compose stack (LiveKit + Redis + Caddy + this app) and `deploy/DEPLOY.md` for the VPS. Caddy passes `lk.<domain>` and `turn.<domain>` through at layer 4 (SNI) and reverse-proxies `app.<domain>` as HTTP, so the app sees the real client address in `X-Forwarded-For`; port 80 redirects to https. `deploy/caddy.yaml` validates with `podman run --rm -v $PWD/caddy.yaml:/etc/caddy.yaml:ro,z docker.io/livekit/caddyl4 validate --config /etc/caddy.yaml --adapter yaml` (after filling in a domain).
- Identities: the camera joins the room as `cam-<device id>`, viewers as `viewer-<device id>`; both pages key their logic off those prefixes.

## Commands

```bash
source venv/bin/activate
pip install -r requirements-dev.txt
pytest                                   # 52 tests, must stay green (LiveKit API calls are monkeypatched)
uvicorn main:app --host 127.0.0.1 --port 8000
python3 setup.py                         # writes config.toml, prints QR codes
```

Local dev without config file (needs the local LiveKit dev server, `podman start petcam-lk`):
`PETCAM_CONFIG=/dev/null PETCAM_HOSTNAME=127.0.0.1:8000 PETCAM_PUBLISHER_KEY=<32+ chars> PETCAM_VIEWER_KEY=<32+ chars> PETCAM_LIVEKIT_URL=ws://127.0.0.1:7880 PETCAM_LIVEKIT_API_KEY=devkey PETCAM_LIVEKIT_API_SECRET=secret`.
Browser E2E (headless Chrome with fake media, Playwright) lives outside the repo; see the Development section of README.md.

## Conventions

- No build step, no npm in the product: plain HTML/CSS/ES2020 JS served by FastAPI. Vendor third-party JS as files under `static/js/vendor/` (CSP is `script-src 'self'`).
- Python: type hints, `from __future__ import annotations`, dataclasses, stdlib `logging`; never log key values.
- Tests live in `tests/` (pytest + Starlette TestClient). They never talk to a LiveKit server: monkeypatch `main.list_room_participants` (see `tests/test_server.py`) so the suite passes with the container down.
- Every user-facing error message must be plain English a non-developer can act on.
- Explain browser workarounds in comments (iOS Safari and Chrome quirks are listed in `docs/VISION_AND_PLAN.md`, section 6).
- The on-page diagnostic log (long-press the status strip, which is always visible on both pages) is the field debugging tool; keep it informative.
- Pairing keys live in localStorage; Safari drops that after seven days without a visit unless the page is on the Home Screen, so the pages rewrite the key on every connect and the docs tell users to add the page to the Home Screen. Never tell users to look for `config.toml` (the Docker deployment has none; keys come from `show-pairing.sh`).

## Gotchas

- The shell's `grep` is ugrep; use `/usr/bin/grep` for PCRE-free, predictable behaviour.
- `config.toml` is gitignored and contains real secrets. Never print or commit it.
- The owner runs the server by hand in a terminal; server changes need a restart.
- Do not commit or push unless asked.
