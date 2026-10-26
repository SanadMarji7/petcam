# Human to-do

Things only the owner can do. Tick them off and tell the agent; the agent keeps working on everything else in the meantime (see `docs/VISION_AND_PLAN.md`, section 4).

## Unblocks local development now

- [x] **Allow local installs.** Done: the `livekit/livekit-server` container (`petcam-lk`) and the `livekit-api` package are installed.
- [x] **Pick the talk mode:** push-to-talk (hold a button, walkie-talkie style) is implemented.

## Needed before deployment (end of Phase 1)

- [ ] **Rent a VPS.** Hetzner CX22 or similar, Ubuntu 24.04, public IPv4. Note the IP here: `__________`
- [ ] **Register / choose a domain** and create three DNS A records pointing at the VPS IP:
  - `app.<domain>` → control plane and pages. Name: `__________`
  - `lk.<domain>` → LiveKit (WebSocket + API). Name: `__________`
  - `turn.<domain>` → LiveKit's TURN/TLS relay (Caddy routes port 443 by host name, so it needs its own name). Name: `__________`
- [ ] **Decide who runs the deploy commands.** Either add an SSH key for this laptop to the VPS (`ssh-copy-id`), or plan to run the steps in `deploy/DEPLOY.md` yourself.
- [ ] **Open the VPS firewall** (or confirm the agent may): TCP 80, 443, 7881; UDP 3478 and 50000-60000.

## Needed for the acceptance test

- [ ] Have the **iPad** (Safari, home Wi‑Fi, on its stand) and the **Pixel** (Chrome, on mobile data, Wi‑Fi off) ready.
- [ ] Optionally a third viewer (iPhone Safari or a laptop) to test three simultaneous viewers.
- [ ] Run the checklist the agent provides and paste the diagnostic log (long-press the status strip) if anything fails.

## Later (Phase 2, not needed yet)

- [ ] Product name and domain for the landing page.
- [ ] Decide sign-in method (email magic link vs Google/Apple).
- [ ] Decide whether recordings are a paid feature.
