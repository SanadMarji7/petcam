// @ts-check
'use strict';

/**
 * Petcam shared browser code, loaded by /cam and /watch with a plain <script>.
 *
 *  - log(): console + on-page diagnostic log (long-press the status strip)
 *  - SignalingClient: WebSocket wrapper with auth handshake, heartbeat, backoff
 *  - readVideoStats() / describeSelectedPair(): small getStats() readers
 *  - helpers for the pairing key in the URL fragment and the per-device id
 */
(function () {
  const Petcam = (window.Petcam = window.Petcam || {});

  // Close codes the server uses (see hub.py).
  const CLOSE = {
    MALFORMED: 4400,
    UNAUTHORIZED: 4401,
    TIMEOUT: 4408,
    TOO_MANY_VIEWERS: 4409,
    REPLACED: 4410,
  };

  // --------------------------------------------------------------- logging

  const MAX_LOG_ENTRIES = 300;
  const logEntries = [];

  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} message
   * @param {unknown} [detail]
   */
  function log(level, message, detail) {
    const ts = new Date().toISOString().substring(11, 19);
    let text = `[${ts}] [${level.toUpperCase()}] ${message}`;
    if (detail !== undefined) {
      try {
        text += ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
      } catch (_) {
        text += ' ' + String(detail);
      }
    }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(text);

    logEntries.push(text);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();

    const container = document.getElementById('log-entries');
    if (container) {
      const el = document.createElement('div');
      el.className = 'log-entry' + (level === 'warn' ? ' warn' : level === 'error' ? ' err' : '');
      el.textContent = text;
      container.appendChild(el);
      while (container.childElementCount > MAX_LOG_ENTRIES) {
        container.removeChild(container.firstChild);
      }
      container.scrollTop = container.scrollHeight;
    }
  }

  /** Long-press (800 ms) on the status strip opens the diagnostic log. */
  function initDiagnosticsUI() {
    const strip = document.getElementById('status-strip') || document.getElementById('publisher-footer');
    const modal = document.getElementById('log-modal');
    const closeBtn = document.getElementById('close-log-btn');
    if (!strip || !modal) return;

    let timer = null;
    const start = () => {
      cancel();
      timer = setTimeout(() => modal.classList.remove('hidden'), 800);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    strip.addEventListener('mousedown', start);
    strip.addEventListener('mouseup', cancel);
    strip.addEventListener('mouseleave', cancel);
    strip.addEventListener('touchstart', start, { passive: true });
    strip.addEventListener('touchend', cancel);
    strip.addEventListener('touchcancel', cancel);
    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));
  }

  // ------------------------------------------------------------- utilities

  /** Pull `#key=...` out of the URL (QR pairing), store it and scrub the address bar. */
  function takeKeyFromFragment(storageKey) {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const key = (params.get('key') || '').trim();
    if (key.length < 32) return null;
    try {
      localStorage.setItem(storageKey, key);
    } catch (_) {
      /* private mode: the key still works for this page load */
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    log('info', 'Pairing key imported from the QR link');
    return key;
  }

  function readStoredKey(storageKey) {
    try {
      return localStorage.getItem(storageKey) || '';
    } catch (_) {
      return '';
    }
  }

  function storeKey(storageKey, value) {
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch (_) {
      /* ignore */
    }
  }

  /** Stable id per browser so a reload replaces the old session instead of adding one. */
  function getDeviceId(storageKey) {
    let id = readStoredKey(storageKey);
    if (!id) {
      const rand =
        window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
          : Math.random().toString(36).slice(2, 14);
      id = 'dev_' + rand;
      storeKey(storageKey, id);
    }
    return id;
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    }
    return Math.random().toString(36).slice(2, 12);
  }

  /** ICE servers from the server config; falls back to none (Tailscale host candidates). */
  async function loadIceServers() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('/config.json', { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data && Array.isArray(data.ice_servers)) {
        log('info', `ICE servers from config: ${data.ice_servers.length}`);
        return data.ice_servers;
      }
    } catch (err) {
      log('warn', `Could not load /config.json (${err.message}); using no STUN`);
    }
    return [];
  }

  function rtcConfig(iceServers) {
    return { iceServers: iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
  }

  function describeCandidate(candidate) {
    if (!candidate) return 'none';
    const c = candidate.candidate || '';
    const parts = c.split(' ');
    // "candidate:... 1 udp 2122 <address> <port> typ host ..."
    const address = parts.length > 5 ? parts[4] : '?';
    const typeIdx = parts.indexOf('typ');
    const type = typeIdx >= 0 ? parts[typeIdx + 1] : candidate.type || '?';
    return `${type} ${address}`;
  }

  // ----------------------------------------------------------- signaling

  class SignalingClient {
    /**
     * @param {Object} o
     * @param {'publisher' | 'viewer'} o.role
     * @param {() => string} o.getKey
     * @param {() => string} [o.getDeviceId]
     * @param {(msg: any) => void} o.onMessage
     * @param {(clientId: string, reconnect: boolean) => void} [o.onOpen]     after auth_ok
     * @param {(code: number, reason: string) => void} [o.onClose]
     * @param {(reason: string) => void} [o.onAuthFailed]                     wrong key: no retry
     * @param {(reason: string) => void} [o.onReplaced]                       newer session took over: no retry
     * @param {(reason: string) => void} [o.onViewerLimit]                    retried slowly
     */
    constructor(o) {
      this.role = o.role;
      this.getKey = o.getKey;
      this.getDeviceId = o.getDeviceId || null;
      this.onMessage = o.onMessage;
      this.onOpen = o.onOpen || (() => {});
      this.onClose = o.onClose || (() => {});
      this.onAuthFailed = o.onAuthFailed || (() => {});
      this.onReplaced = o.onReplaced || (() => {});
      this.onViewerLimit = o.onViewerLimit || (() => {});

      /** @type {WebSocket | null} */
      this.ws = null;
      this.clientId = null;
      this.authenticated = false;
      this.everAuthenticated = false;
      this.stopped = false;
      this.reconnectAttempts = 0;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      this.lastPong = 0;
    }

    get isOpen() {
      return this.authenticated && !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    connect() {
      this.stopped = false;
      this.clearReconnectTimer();
      const key = this.getKey();
      if (!key) {
        log('warn', 'Not connecting: no key');
        return;
      }
      this.disposeSocket();

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/${this.role}`;
      log('info', `Signaling: connecting to ${url}`);

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        log('error', `WebSocket could not be created: ${err.message}`);
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      this.authenticated = false;

      ws.onopen = () => {
        if (ws !== this.ws) return;
        const auth = { type: 'auth', key: this.getKey() };
        if (this.getDeviceId) auth.device_id = this.getDeviceId();
        this.send(auth);
      };

      ws.onmessage = (event) => {
        if (ws !== this.ws) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          log('warn', 'Signaling: ignored a non-JSON frame');
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'auth_ok') {
          const reconnect = this.everAuthenticated;
          this.authenticated = true;
          this.everAuthenticated = true;
          this.clientId = msg.id;
          this.reconnectAttempts = 0;
          this.lastPong = Date.now();
          this.startHeartbeat();
          log('info', `Signaling: authenticated as ${this.role} [${this.clientId}]${reconnect ? ' (reconnected)' : ''}`);
          this.onOpen(this.clientId, reconnect);
          return;
        }
        if (msg.type === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        this.onMessage(msg);
      };

      ws.onerror = () => {
        if (ws !== this.ws) return;
        log('warn', 'Signaling: socket error');
      };

      ws.onclose = (event) => {
        if (ws !== this.ws) return;
        this.ws = null;
        this.authenticated = false;
        this.stopHeartbeat();
        const reason = event.reason || 'closed';
        log('warn', `Signaling: closed (code ${event.code}: ${reason})`);
        this.onClose(event.code, reason);

        if (event.code === CLOSE.UNAUTHORIZED) {
          this.onAuthFailed(reason);
          return;
        }
        if (event.code === CLOSE.REPLACED) {
          this.stopped = true;
          this.onReplaced(reason);
          return;
        }
        if (event.code === CLOSE.TOO_MANY_VIEWERS) {
          this.onViewerLimit(reason);
          if (!this.stopped) this.scheduleReconnect(30000);
          return;
        }
        if (!this.stopped) this.scheduleReconnect();
      };
    }

    /** @returns {boolean} */
    send(data) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        log('warn', `Signaling: cannot send '${data && data.type}' (socket not open)`);
        return false;
      }
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch (err) {
        log('error', `Signaling: send failed: ${err.message}`);
        return false;
      }
    }

    startHeartbeat() {
      this.stopHeartbeat();
      // Ping every 10 s (server drops silent clients after 30 s). If no pong
      // comes back for 25 s the TCP connection is dead (e.g. Wi-Fi -> 5G
      // switch): close it ourselves so the reconnect happens now, not minutes later.
      this.heartbeatTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastPong > 25000) {
          log('warn', 'Signaling: no pong for 25 s, forcing reconnect');
          try {
            this.ws.close(4000, 'pong timeout');
          } catch (_) {
            /* ignore */
          }
          return;
        }
        this.send({ type: 'ping' });
      }, 10000);
    }

    stopHeartbeat() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    scheduleReconnect(minDelayMs) {
      if (this.reconnectTimer || this.stopped) return;
      this.reconnectAttempts += 1;
      // 1 s, 2 s, 4 s ... capped at 30 s, plus jitter so devices do not stampede.
      let delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts - 1)) + Math.random() * 500;
      if (minDelayMs) delay = Math.max(delay, minDelayMs);
      log('info', `Signaling: reconnect in ${(delay / 1000).toFixed(1)} s (attempt ${this.reconnectAttempts})`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }

    /** Reconnect right now (network came back, user tapped Reconnect). */
    reconnectNow() {
      this.reconnectAttempts = 0;
      this.connect();
    }

    clearReconnectTimer() {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    disposeSocket() {
      const old = this.ws;
      this.ws = null;
      this.authenticated = false;
      this.stopHeartbeat();
      if (old) {
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try {
          old.close(1000, 'superseded');
        } catch (_) {
          /* ignore */
        }
      }
    }

    close() {
      this.stopped = true;
      this.clearReconnectTimer();
      this.disposeSocket();
    }
  }

  // ---------------------------------------------------------------- stats

  /**
   * @param {RTCPeerConnection | null} pc
   * @param {'inbound' | 'outbound'} direction
   * @returns {Promise<{width: number, height: number, fps: number, frames: number, bytes: number}>}
   */
  async function readVideoStats(pc, direction) {
    const result = { width: 0, height: 0, fps: 0, frames: 0, bytes: 0 };
    if (!pc || pc.connectionState === 'closed') return result;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.kind !== 'video' && report.mediaType !== 'video') return;
        if (direction === 'inbound' && report.type === 'inbound-rtp') {
          result.width = report.frameWidth || 0;
          result.height = report.frameHeight || 0;
          result.fps = report.framesPerSecond ? Math.round(report.framesPerSecond) : 0;
          result.frames = report.framesDecoded || 0;
          result.bytes = report.bytesReceived || 0;
        } else if (direction === 'outbound' && report.type === 'outbound-rtp') {
          result.width = report.frameWidth || 0;
          result.height = report.frameHeight || 0;
          result.fps = report.framesPerSecond ? Math.round(report.framesPerSecond) : 0;
          result.frames = report.framesEncoded || 0;
          result.bytes = report.bytesSent || 0;
        }
      });
    } catch (_) {
      /* connection closed mid-call */
    }
    return result;
  }

  /** "host 100.1.2.3 -> prflx 100.4.5.6" for the active ICE pair, or null. */
  async function describeSelectedPair(pc) {
    if (!pc || pc.connectionState === 'closed') return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r;
        });
      }
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const fmt = (c) => (c ? `${c.candidateType || '?'} ${c.address || c.ip || '?'}:${c.port || '?'}` : '?');
      return `${fmt(local)} -> ${fmt(remote)}`;
    } catch (_) {
      return null;
    }
  }

  Petcam.CLOSE = CLOSE;
  Petcam.log = log;
  Petcam.initDiagnosticsUI = initDiagnosticsUI;
  Petcam.takeKeyFromFragment = takeKeyFromFragment;
  Petcam.readStoredKey = readStoredKey;
  Petcam.storeKey = storeKey;
  Petcam.getDeviceId = getDeviceId;
  Petcam.randomId = randomId;
  Petcam.loadIceServers = loadIceServers;
  Petcam.rtcConfig = rtcConfig;
  Petcam.describeCandidate = describeCandidate;
  Petcam.SignalingClient = SignalingClient;
  Petcam.readVideoStats = readVideoStats;
  Petcam.describeSelectedPair = describeSelectedPair;

  document.addEventListener('DOMContentLoaded', initDiagnosticsUI);
})();
