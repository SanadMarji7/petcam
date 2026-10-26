# Petcam control plane image. Build context is the repository root:
#   docker compose build petcam        (from the deploy/ directory)
# deploy/Dockerfile.dockerignore keeps venv/, .git/ and config.toml out of the
# build context.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first so code changes do not re-run pip install.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Only what the server needs at runtime. setup.py and hub.py are not copied:
# setup.py is a laptop-side assistant and hub.py belongs to the old design.
COPY main.py config.py qrgen.py ./
COPY templates/ ./templates/
COPY static/ ./static/

# Run as an unprivileged user; the app never writes to disk.
RUN useradd --system --uid 10001 --no-create-home petcam \
    && chown -R petcam:petcam /app
USER petcam

EXPOSE 8000

# curl is not in the slim image; urllib does the same job. /healthz always
# answers 200 when the app is up, even if LiveKit is down (it reports that in
# the body), so this check only says "the Python process answers".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

# Configuration comes from PETCAM_* environment variables (petcam.env). There
# is no config.toml in the image; config.py falls back to the environment
# when the file is absent.
# One worker: the viewer-limit bookkeeping lives in process memory, and more
# workers would only add memory for a single-camera deployment.
# --forwarded-allow-ips "*": the only way to reach this port is through Caddy
# (docker-compose.yml publishes it on 127.0.0.1 only), and Caddy sets
# X-Forwarded-For to the real client address (deploy/caddy.yaml), so uvicorn
# may trust it from any peer; the log then shows who asked for a token. The
# container sees Caddy as the Docker gateway address, which is why the
# default (trust 127.0.0.1 only) is not enough here.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--log-level", "info", "--proxy-headers", "--forwarded-allow-ips", "*"]
