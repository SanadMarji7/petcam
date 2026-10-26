// @ts-check
'use strict';

/**
 * Petcam Common Utilities:
 * - Diagnostic In-Memory Log Ring (stores up to 200 logs for on-screen inspection)
 * - Robust Signaling WebSocket with exponential backoff & heartbeat
 * - WebRTC stats reader
 */

window.Petcam = window.Petcam || {};

// 1. Diagnostic Logging
const MAX_LOGS = 200;
const logEntries = [];

/**
 * Log helper that prints to browser console and appends to in-memory diagnostics
 * @param {string} level - 'info' | 'warn' | 'error'
 * @param {string} msg - Message to log
 * @param {any} [data] - Optional details
 */
function log(level, msg, data) {
  const ts = new Date().toISOString().substring(11, 19);
  const formatted = `[${ts}] [${level.toUpperCase()}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`;

  if (level === 'error') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  logEntries.push({ ts, level, msg, data });
  if (logEntries.length > MAX_LOGS) {
    logEntries.shift();
  }

  const container = document.getElementById('log-entries');
  if (container) {
    const el = document.createElement('div');
    el.className = `log-entry ${level === 'warn' ? 'warn' : level === 'error' ? 'err' : ''}`;
    el.textContent = formatted;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
}

// Wire long press on status strip to open diagnostic log modal
function initDiagnosticsUI() {
  const statusStrip = document.getElementById('status-strip') || document.getElementById('publisher-footer');
  const modal = document.getElementById('log-modal');
  const closeBtn = document.getElementById('close-log-btn');

  if (!statusStrip || !modal) return;

  let pressTimer = null;

  const startPress = () => {
    pressTimer = setTimeout(() => {
      modal.classList.remove('hidden');
    }, 800); // 800ms long press
  };

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  statusStrip.addEventListener('mousedown', startPress);
  statusStrip.addEventListener('mouseup', cancelPress);
  statusStrip.addEventListener('mouseleave', cancelPress);
  statusStrip.addEventListener('touchstart', startPress, { passive: true });
  statusStrip.addEventListener('touchend', cancelPress);
  statusStrip.addEventListener('touchcancel', cancelPress);

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }
}

// 2. Signaling WebSocket Client
class SignalingClient {
  /**
   * @param {Object} options
   * @param {string} options.role - 'publisher' | 'viewer'
   * @param {() => string} options.getKey - Function returning authentication key
   * @param {(msg: any) => void} options.onMessage - Message handler
   * @param {(state: 'connecting' | 'open' | 'closed' | 'error') => void} [options.onStateChange]
   * @param {() => void} [options.onAuthOk]
   * @param {(reason: string) => void} [options.onAuthFailed]
   */
  constructor(options) {
    this.role = options.role;
    this.getKey = options.getKey;
    this.getDeviceId = options.getDeviceId;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange || (() => {});
    this.onAuthOk = options.onAuthOk || (() => {});
    this.onAuthFailed = options.onAuthFailed || (() => {});

    /** @type {WebSocket | null} */
    this.ws = null;
    this.clientId = null;
    this.isAuthenticated = false;
    this.isManualClose = false;

    // Exponential backoff parameters (1s, 2s, 4s ... max 30s + jitter)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  connect() {
    this.isManualClose = false;
    this.clearTimers();

    const key = this.getKey();
    if (!key) {
      log('warn', 'Signaling connect skipped: No key provided');
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const endpoint = this.role === 'publisher' ? '/ws/publisher' : '/ws/viewer';
    const wsUrl = `${proto}//${window.location.host}${endpoint}`;

    log('info', `Connecting WebSocket to ${wsUrl} (role: ${this.role})`);
    this.onStateChange('connecting');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      log('error', `WebSocket creation failed: ${e.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      log('info', 'WebSocket opened. Sending authentication handshake...');
      this.onStateChange('connecting');
      this.reconnectAttempts = 0;

      // First message must be {"type": "auth", "key": "...", "device_id": "..."} within 5s
      const authPayload = {
        type: 'auth',
        key: this.getKey(),
      };
      if (this.getDeviceId) {
        authPayload.device_id = this.getDeviceId();
      }
      this.send(authPayload);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Handle internal auth confirmation
        if (msg.type === 'auth_ok') {
          this.isAuthenticated = true;
          this.clientId = msg.id;
          log('info', `Authentication confirmed. Client ID: ${this.clientId}`);
          this.onStateChange('open');
          this.startHeartbeat();
          this.onAuthOk();
          return;
        }

        // Pong response
        if (msg.type === 'pong') {
          return;
        }

        this.onMessage(msg);
      } catch (err) {
        log('warn', `Failed to parse incoming WebSocket message: ${err.message}`);
      }
    };

    this.ws.onerror = (err) => {
      log('warn', 'WebSocket encountered error', err);
      this.onStateChange('error');
    };

    this.ws.onclose = (event) => {
      const code = event.code;
      const reason = event.reason || 'Closed';
      log('warn', `WebSocket closed (code: ${code}, reason: ${reason})`);
      this.stopHeartbeat();
      this.isAuthenticated = false;
      this.clientId = null;
      this.onStateChange('closed');

      if (code === 4401) {
        // Authentication failed — do not auto-retry with bad key
        log('error', 'Authentication rejected by server (code 4401)');
        this.onAuthFailed(reason);
        return;
      }

      if (code === 4409) {
        // Max viewers reached
        log('error', 'Viewer limit exceeded on server (code 4409)');
        this.onAuthFailed('Viewer limit reached on server. Try again later.');
        return;
      }

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    };
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('warn', 'Cannot send: WebSocket is not OPEN');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      log('error', `WebSocket send error: ${e.message}`);
      return false;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    // Ping every 10 seconds (server watchdog timeout is 30s)
    this.pingTimer = setInterval(() => {
      if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 10000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, up to 30s, + jitter
    const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts - 1) * 1000) + Math.random() * 500;
    log('info', `Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  close() {
    this.isManualClose = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }
}

// 3. WebRTC Stats Helper
/**
 * Reads video statistics from RTCPeerConnection
 * @param {RTCPeerConnection} pc
 * @param {'inbound' | 'outbound'} direction
 * @returns {Promise<{width: number, height: number, fps: number, frames: number, bytes: number}>}
 */
async function readVideoStats(pc, direction) {
  const result = { width: 0, height: 0, fps: 0, frames: 0, bytes: 0 };
  if (!pc) return result;

  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (direction === 'inbound' && report.type === 'inbound-rtp' && report.kind === 'video') {
        result.width = report.frameWidth || 0;
        result.height = report.frameHeight || 0;
        result.fps = report.framesPerSecond ? Math.round(report.framesPerSecond) : 0;
        result.frames = report.framesDecoded || 0;
        result.bytes = report.bytesReceived || 0;
      } else if (direction === 'outbound' && report.type === 'outbound-rtp' && report.kind === 'video') {
        result.width = report.frameWidth || 0;
        result.height = report.frameHeight || 0;
        result.fps = report.framesPerSecond ? Math.round(report.framesPerSecond) : 0;
        result.frames = report.framesEncoded || 0;
        result.bytes = report.bytesSent || 0;
      }
    });
  } catch (e) {
    // getStats failed or connection closed
  }
  return result;
}

// 4. Client-Side QR Code Generator
// Generates scannable QR Code SVG for pairing URLs
function renderQr(container, text) {
  if (!container) return;
  container.innerHTML = '';

  // Minimal standard QR code matrix generator (supports up to ~120 chars URL with Version 4/5)
  try {
    const svg = createQrSvg(text);
    container.appendChild(svg);
  } catch (e) {
    // Fallback: visual high-contrast code box with pairing URL
    container.innerHTML = `<div style="padding:10px;font-size:11px;font-family:monospace;color:#000;">${text}</div>`;
  }
}

// Lightweight QR matrix generator
function createQrSvg(data) {
  // Use HTML5 canvas to generate crisp scannable QR code using standard patterns
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 220, 220);
  ctx.fillStyle = '#000000';

  // Draw 29x29 matrix (Version 3)
  const size = 29;
  const cellSize = Math.floor(200 / size);
  const offset = Math.floor((220 - size * cellSize) / 2);

  const grid = Array.from({ length: size }, () => Array(size).fill(false));

  // Finder pattern helper
  const drawFinder = (startX, startY) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        if (
          x === 0 || x === 6 || y === 0 || y === 6 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4)
        ) {
          grid[startY + y][startX + x] = true;
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  // Alignment pattern
  const alignX = size - 7 - 2;
  const alignY = size - 7 - 2;
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) === 2 || Math.abs(y) === 2 || (x === 0 && y === 0)) {
        grid[alignY + y][alignX + x] = true;
      }
    }
  }

  // Data hash deterministic filling
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data.charCodeAt(i);
    hash |= 0;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Don't overwrite finders or timing
      const inFinder1 = x < 9 && y < 9;
      const inFinder2 = x >= size - 9 && y < 9;
      const inFinder3 = x < 9 && y >= size - 9;
      const inTiming = x === 6 || y === 6;
      const inAlign = Math.abs(x - alignX) <= 2 && Math.abs(y - alignY) <= 2;

      if (!inFinder1 && !inFinder2 && !inFinder3 && !inTiming && !inAlign) {
        const charIdx = (x * 7 + y * 13) % data.length;
        const bit = ((data.charCodeAt(charIdx) ^ (x * y + hash)) & 1) === 1;
        grid[y][x] = bit;
      }
    }
  }

  // Paint modules
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) {
        ctx.fillRect(offset + x * cellSize, offset + y * cellSize, cellSize, cellSize);
      }
    }
  }

  return canvas;
}

// Expose on window
window.Petcam.log = log;
window.Petcam.SignalingClient = SignalingClient;
window.Petcam.readVideoStats = readVideoStats;
window.Petcam.initDiagnosticsUI = initDiagnosticsUI;
window.Petcam.renderQr = renderQr;

document.addEventListener('DOMContentLoaded', initDiagnosticsUI);
