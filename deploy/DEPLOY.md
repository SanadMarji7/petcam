# Deploying Petcam on a VPS

This guide takes a fresh Ubuntu 24.04 server to a working Petcam in about
30 minutes. It assumes no Docker or networking experience; every command is
given in full. Where you see `<domain>`, put your own domain (for example
`example.com`).

What you end up with:

| Name | What it serves |
| --- | --- |
| `https://app.<domain>` | The camera page (`/cam`) and viewer page (`/watch`), token minting |
| `wss://lk.<domain>` | LiveKit, the media server the browsers stream through |
| `turn.<domain>` | LiveKit's TURN relay over TLS, for phones on strict networks |

All three share port 443 on one machine. Caddy obtains the certificates and
routes each connection to the right service by its server name.

## 1. What you need

- A VPS with a **public IPv4 address**, 2 GB RAM, Ubuntu 24.04 (Hetzner
  CX22 class, about 5 EUR/month). Video goes through this machine, so pick a
  location close to where the viewers are.
- A **domain** you control, with access to its DNS records.
- A terminal on your laptop with `ssh`.

## 2. DNS records

In your DNS provider, create three **A** records pointing at the VPS IPv4
address (replace `203.0.113.10` with your server's IP):

```
app.<domain>    A    203.0.113.10
lk.<domain>     A    203.0.113.10
turn.<domain>   A    203.0.113.10
```

If the VPS also has an IPv6 address, you may add matching **AAAA** records,
but it is not required.

Wait until the names resolve before going on. From your laptop:

```bash
getent hosts app.<domain> lk.<domain> turn.<domain>
```

Each line should show the server's IP. DNS changes can take a few minutes.

## 3. First login and updates

```bash
ssh root@203.0.113.10
apt update && apt upgrade -y
```

If the upgrade installed a new kernel, `reboot` and log in again.

## 4. Firewall

Ubuntu ships `ufw`. Allow SSH first, then exactly the ports Petcam needs,
then switch it on:

```bash
ufw allow OpenSSH
ufw allow 80/tcp          # Let's Encrypt certificate checks
ufw allow 443/tcp         # pages, LiveKit signaling, TURN over TLS
ufw allow 7881/tcp        # WebRTC media over TCP (networks that block UDP)
ufw allow 3478/udp        # TURN over UDP
ufw allow 50000:60000/udp # WebRTC media over UDP
ufw enable
ufw status
```

Answer `y` when it asks whether to proceed. Some providers (Hetzner, for
example) also have a firewall in their web console; open the same ports
there, or disable that firewall for this server.

The firewall is what keeps LiveKit's internal ports (7880, 5349, 6379) off
the internet, so do not skip this step.

## 5. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

Both commands should print a version. Docker starts on boot by itself.

## 6. Get Petcam

```bash
apt install -y git
git clone https://github.com/SanadMarji7/petcam.git /opt/petcam
cd /opt/petcam/deploy
```

## 7. Configure

One command fills your domain into the config files and generates all the
random keys:

```bash
./configure.sh <domain>
```

It writes `petcam.env` (private, readable only by root) with:

- `PETCAM_PUBLISHER_KEY` and `PETCAM_VIEWER_KEY`: the two pairing keys that
  end up in the QR codes,
- `PETCAM_LIVEKIT_API_KEY` / `PETCAM_LIVEKIT_API_SECRET` and the same pair
  as `LIVEKIT_KEYS`: how the control plane proves to LiveKit that it may mint
  tokens.

To do it by hand instead: replace every `<domain>` in `caddy.yaml` and
`livekit.yaml`, then `cp petcam.env.example petcam.env` and fill it in,
generating each key with `openssl rand -hex 32`. The LiveKit key/secret must
be identical in `PETCAM_LIVEKIT_API_*` and `LIVEKIT_KEYS`.

Optional settings in `petcam.env`: `PETCAM_MAX_VIEWERS` (default 4).

## 8. First start

```bash
docker compose up -d --build
```

The first run downloads the images and builds the Petcam image (one to two
minutes). Then watch Caddy obtain the certificates:

```bash
docker compose logs -f caddy
```

Within a minute you should see lines containing `certificate obtained
successfully` for all three names. Press Ctrl-C to stop following the log.
If it keeps retrying, DNS is not pointing at this server yet or port 80 is
blocked; fix that and run `docker compose restart caddy`.

## 9. Verify

From your laptop (or the server):

```bash
curl https://app.<domain>/healthz
```

Expected:

```json
{"livekit": true, "camera": false, "viewers": 0, "max_viewers": 4, "room": "petcam"}
```

- `"livekit": true` means the control plane can talk to LiveKit through
  `https://lk.<domain>`. If it says `false`, see Troubleshooting below.
- `"camera": false` is normal until the iPad is streaming.

Then check that `https://app.<domain>/watch` opens in a browser and shows
the key card.

## 10. Pairing QR codes

```bash
./show-pairing.sh
```

It prints two QR codes in the terminal. Scan the first with the iPad's
Camera app (it opens `/cam` with the key filled in) and the second with each
phone or laptop that should watch. The codes contain secret keys; do not
screenshot or forward them. The README explains the iPad checklist and the
viewer controls.

If a terminal QR code is hard to scan, the same codes exist as a web page.
The control plane prints its address, including a random access token, every
time it starts:

```bash
docker compose logs petcam | grep 'Pairing page'
```

Open the `https://app.<domain>/setup?token=...` link from that line in a
browser. Without the token the page is refused, whoever asks and from
wherever; the token changes on every restart of the `petcam` container.

## 11. Day-to-day

Logs:

```bash
cd /opt/petcam/deploy
docker compose logs -f              # everything
docker compose logs -f petcam       # the control plane only
docker compose logs -f livekit      # the media server
docker compose logs --tail 100 caddy
```

Status and restart:

```bash
docker compose ps
docker compose restart petcam
```

Changing a setting in `petcam.env` (for example `PETCAM_MAX_VIEWERS`):

```bash
docker compose up -d                # recreates only the containers whose env changed
```

Stop everything (certificates and keys stay on disk):

```bash
docker compose down
```

## 12. Updating Petcam

```bash
cd /opt/petcam
git pull
cd deploy
docker compose up -d --build
```

This rebuilds the control-plane image and restarts only what changed.
Viewers reconnect by themselves within a few seconds. To update LiveKit or
Caddy, change the image tag in `docker-compose.yml`, then run the same
command; check the LiveKit release notes first.

## 13. Changing the keys

Delete `petcam.env`, run `./configure.sh <domain>` again, then
`docker compose up -d`. Every device must scan the new QR codes.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `curl https://app.<domain>/healthz` fails with a certificate error or connection refused | Caddy has no certificate yet | `docker compose logs caddy`. Check DNS (`getent hosts app.<domain>`) and that TCP 80 and 443 are open. |
| `/healthz` says `"livekit": false` | LiveKit is down, or its API key/secret differ between `PETCAM_LIVEKIT_API_*` and `LIVEKIT_KEYS` in `petcam.env` | `docker compose logs livekit`. Make sure both lines use the same key and secret, then `docker compose up -d`. |
| LiveKit log says `no api keys` or `invalid keys` | `LIVEKIT_KEYS` missing or wrong format | It must read `LIVEKIT_KEYS=<key>: <secret>` with a space after the colon. |
| Viewer connects but video never starts; diagnostic log shows the connection stuck | UDP ports blocked | Open UDP 50000-60000 and 3478 in both `ufw` and the provider's firewall. TCP 7881 alone works but with more delay. |
| Camera page shows "Wrong key" after the keys changed | Old QR scanned | `./show-pairing.sh` and scan again. |
| `https://app.<domain>/setup` shows "Pairing page is locked" | The link was opened without its token | Use the full link from `docker compose logs petcam \| grep 'Pairing page'`, or run `./show-pairing.sh`. |
| `docker compose logs petcam` shows every token request coming from the same address | Caddy is not passing the client address on | Make sure `caddy.yaml` is the version from this repository (the `app.<domain>` route uses `reverse_proxy`), then `docker compose restart caddy`. |
| `docker compose up` fails with "address already in use" on 80 or 443 | Another web server (Apache, nginx) is running on the VPS | `systemctl disable --now apache2 nginx` or use a fresh VPS. |
| Everything worked, then stopped after a reboot | Docker did not start | `systemctl enable --now docker`, then `docker compose up -d`. |

To see what the server is doing from a phone, long-press the status strip
on either page to open the on-page diagnostic log.

## What the files are

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The four services: Caddy, LiveKit, Redis, Petcam |
| `caddy.yaml` | Certificates, port-443 routing by server name, the http:// to https:// redirect |
| `livekit.yaml` | LiveKit ports, TURN and Redis settings (no secrets) |
| `redis.conf` | Redis bound to localhost |
| `petcam.env.example` | Template for `petcam.env` (the only file with secrets) |
| `Dockerfile` | Builds the Petcam control-plane image |
| `configure.sh` | Fills the domain in and generates `petcam.env` |
| `show-pairing.sh` | Prints the pairing QR codes |
