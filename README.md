# Petcam — Self-Hosted WebRTC Dog Cam

A private, self-healing dog monitor: an old iPad streams camera and microphone from home, and up to 4 phones or laptops (primarily a Google Pixel) watch it live with near-zero latency from anywhere.

Private by design: nothing is exposed to the public internet. All traffic flows directly between devices over your private **Tailscale** mesh network using end-to-end encrypted WebRTC.

---

## 1. What You Need

1. **Home Server:** An always-on machine at home (Raspberry Pi 4, mini PC, or old laptop) running Linux (Ubuntu, Debian, or Raspberry Pi OS).
2. **Publisher Device (iPad):** An iPad running iOS 16.4+ on a stand with its charger plugged in.
3. **Viewer Devices:** Your phone (e.g. Google Pixel) or laptop.
4. **Tailscale Account:** A free [Tailscale](https://tailscale.com) account.

---

## 2. Install the Server

Clone the repository on your home server:

```bash
git clone https://github.com/SanadMarji7/petcam.git
cd petcam
```

Create a Python 3.11+ virtual environment and install the pinned dependencies:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Generate two secure random 32-character authentication keys:

```bash
python3 -c "import secrets; print('publisher_key = \"' + secrets.token_urlsafe(32) + '\"')"
python3 -c "import secrets; print('viewer_key = \"' + secrets.token_urlsafe(32) + '\"')"
```

Copy the example configuration:

```bash
cp config.example.toml config.toml
nano config.toml
```

Paste your generated keys and set your Tailscale hostname:

```toml
hostname = "dogcam.your-tailnet.ts.net"
publisher_key = "PASTE_YOUR_32_CHAR_PUBLISHER_KEY_HERE"
viewer_key = "PASTE_YOUR_32_CHAR_VIEWER_KEY_HERE"
max_viewers = 4
stun_enabled = false
port = 8000
```

---

## 3. Tailscale & HTTPS Setup

WebRTC media capture (`getUserMedia`) requires a secure HTTPS context. Tailscale provides real Let's Encrypt certificates with no manual CA installation or router port forwarding.

1. **Install Tailscale on the server:**
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. **Enable MagicDNS and HTTPS Certificates:**
   - In the [Tailscale Admin Console](https://login.tailscale.com/admin/dns), enable **MagicDNS**.
   - Enable **HTTPS Certificates**.
3. **Serve HTTPS via Tailscale Serve:**
   ```bash
   sudo tailscale serve --bg https / http://127.0.0.1:8000
   ```
   *Note:* The Uvicorn server listens on `127.0.0.1:8000` only, never on `0.0.0.0`. `tailscale serve` terminates HTTPS and proxies requests securely.
4. **Install Tailscale on iPad and Pixel:**
   - Install the official Tailscale app from the App Store / Google Play Store.
   - Sign in with the exact same account.
   - On iOS, toggle the switch to **Connected** and tap **Allow** when prompted to add VPN configurations.

---

## 4. Run as a Systemd Service

To ensure the server starts automatically on boot and recovers if restarted:

1. Edit `dogcam.service` and adjust `User`, `Group`, and `WorkingDirectory` if your username is not `pi`:
   ```bash
   nano dogcam.service
   ```
2. Copy the unit file and enable it:
   ```bash
   sudo cp dogcam.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now dogcam
   ```
3. Verify server status and logs:
   ```bash
   sudo systemctl status dogcam
   sudo journalctl -u dogcam -f
   ```
4. Test the health check endpoint from any device on your Tailnet:
   ```bash
   curl https://dogcam.your-tailnet.ts.net/healthz
   # Output: {"publisher": false, "viewers": 0, "max_viewers": 4}
   ```

---

## 5. iPad Setup Checklist (Unattended Reliability)

Safari suspends `getUserMedia` video capture if the tab is backgrounded or if the device screen locks. Following this checklist is what keeps the stream running unattended for hours and days:

1. **Power and Mount:** Place the iPad on a sturdy stand aimed at your dog's favorite bed or room spot, and keep it plugged into wall power.
2. **Auto-Lock to Never:** Open **Settings → Display & Brightness → Auto-Lock** and select **Never**. Dim the screen brightness to near-minimum.
3. **Enable Guided Access:**
   - Open **Settings → Accessibility → Guided Access** and toggle it **On**.
   - Under *Passcode Settings*, set a passcode.
4. **Start the Camera:**
   - Open Safari and navigate to: `https://dogcam.your-tailnet.ts.net/cam`
   - Paste your 32-character `publisher_key` once (it saves in `localStorage`).
   - Select your desired lens (default: Back Camera).
   - Tap **Start Camera**, and allow Camera and Microphone permissions.
5. **Lock with Guided Access:**
   - Triple-click the top or side button to engage **Guided Access**. This locks Safari in place so notifications, Siri, or accidental swipes cannot close or background the tab.
6. **Activate Screen-Off Mode:**
   - Tap the **Screen Off** button on the top right, or simply wait 60 seconds.
   - The screen will turn completely black (`#000`), turning off OLED/LCD backlight glare while the camera stream, audio, and WebRTC peer connections continue running at full speed in the background.
   - Tapping anywhere on the black screen immediately restores the controls.
7. **Important:** **Do not press the iPad physical power lock button.** Keeping Guided Access active with Auto-Lock set to Never preserves the camera capture pipeline continuously.

---

## 6. Pixel / Viewer Setup

1. On your Google Pixel (or any phone/laptop), open Chrome and navigate to:
   ```
   https://dogcam.your-tailnet.ts.net/watch
   ```
2. Enter your 32-character `viewer_key` once.
3. The stream connects within seconds:
   - **Audio:** Tap **Unmute** on the bottom bar to hear live audio (browsers require a user click before playing audio).
   - **Quality:** Toggle between **Auto (800 kbps, 15 fps)** for mobile data and **High (2 Mbps, 30 fps)** for home Wi-Fi.
   - **Fullscreen:** Tap the video once to enter fullscreen mode.
4. **Install as Home Screen App:**
   - In Chrome, tap the three dots `⋮` → **Add to Home screen**.
   - Thanks to the web app manifest, it opens as a clean standalone app with its own icon and dark titlebar.
5. **Network switching:** If your phone switches between Wi-Fi and 5G cellular, the built-in watchdog detects dropped packets and automatically triggers an ICE restart within seconds.

---

## 7. Troubleshooting Table

| Symptom | Probable Cause | Concrete Fix |
| :--- | :--- | :--- |
| **Black video / Frozen stream** | iPad screen was locked with power button, or tab was backgrounded | Keep iPad unlocked inside Guided Access with Auto-Lock set to Never. Tap screen to wake UI and ensure status says "Streaming". |
| **ICE status stuck on `checking`** | Tailscale is disconnected on either the server, iPad, or phone | Open the Tailscale app on both devices; toggle VPN off and back on. Verify Tailscale IP connectivity with `tailscale ping <device>`. |
| **`Camera offline` banner on viewer** | iPad publisher is not currently running | Open Safari on the iPad, navigate to `/cam` and tap "Start camera". |
| **WebSocket closed with code `4401`** | Wrong authentication key or hostname mismatch | Verify that the key pasted into the webpage matches `publisher_key` / `viewer_key` in `config.toml`. Check that `Origin` header matches `hostname`. Tap "Forget Key" to re-enter. |
| **WebSocket closed with code `4409`** | More than 4 viewers are already connected | Increase `max_viewers` in `config.toml` if your home network and server have sufficient bandwidth. |
| **Video playing but no sound** | Browser blocked unmuted autoplay | Tap the **Unmute** button in the bottom control bar to unlock browser audio. |
| **Watchdog triggering restarts** | Poor local Wi-Fi signal between iPad and router | Move iPad closer to Wi-Fi access point or set quality to Auto (800 kbps). |

---

## 8. Optional: Local-Only Development

For development without Tailscale on your local machine:

1. Install `mkcert` and generate a trusted local certificate:
   ```bash
   mkcert -install
   mkcert localhost 127.0.0.1
   ```
2. Start Uvicorn with reload:
   ```bash
   uvicorn main:app --reload --host 127.0.0.1 --port 8000
   ```
3. Open `https://localhost:8000/cam` and `https://localhost:8000/watch`.
4. *Note:* Local development is for code testing only. Production deployment must always use Tailscale HTTPS for unattended remote access.

---

## Architecture Summary

```
                +-------------------------+
                |  Home Linux Server      |
                |  (Uvicorn 127.0.0.1:8000)
                |  Tailscale HTTPS Relay  |
                +------------+------------+
                             |
             Signaling via WebSockets (WSS)
                             |
         +-------------------+-------------------+
         |                                       |
+--------+--------+                     +--------+--------+
|   iPad (Cam)    |<===================>|  Pixel (Watch)  |
| Hardware H.264  |     Direct Media    | Low-latency P2P |
| Screen-Off Mode |     Over Tailscale  | Auto-Watchdog   |
+-----------------+                     +-----------------+
```

- **Zero Cloud Costs:** Runs 100% on hardware you already own.
- **Zero Public Ports:** Router ports remain closed; immune to public internet scans.
- **Self-Healing:** Watchdogs monitor frame progression every 2–5 seconds and auto-recover stalled connections without manual intervention.
