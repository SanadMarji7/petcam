#!/usr/bin/env bash
# Prints the two pairing QR codes (iPad camera page, viewer page) in the
# terminal, using the keys the running petcam container was started with.
#
#   ./show-pairing.sh
#
# Both codes contain a secret key: do not screenshot or forward them.
# Alternative: the server prints a link to its /setup page (same codes, in a
# browser) when it starts; find it with  docker compose logs petcam | grep 'Pairing page'
# and open the https://app.<domain>/setup?token=... form of it.
set -euo pipefail
cd "$(dirname "$0")"

if ! docker compose ps --status running petcam 2>/dev/null | /usr/bin/grep -q petcam; then
    echo "The petcam container is not running. Start it with:  docker compose up -d" >&2
    exit 1
fi

# -T: no pseudo-terminal, so the Python program can be piped in on stdin.
docker compose exec -T petcam python3 - <<'PY'
from config import load_settings
from qrgen import matrix_to_terminal, qr_matrix

settings = load_settings()
pages = (
    ("1. iPad (camera): scan with the Camera app, it opens /cam", settings.cam_pairing_url),
    ("2. Phone or laptop (viewer): scan with the camera, it opens /watch", settings.watch_pairing_url),
)
for label, url in pages:
    print()
    print(label)
    print(matrix_to_terminal(qr_matrix(url)))
    print(url)
print()
print("If a code does not scan, make the terminal font smaller so the whole square fits.")
PY
