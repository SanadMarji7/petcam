// @ts-check
'use strict';

/**
 * Petcam shared browser code, loaded by /cam and /watch with a plain <script>
 * after the vendored LiveKit client (static/js/vendor/livekit-client.umd.js).
 *
 *  - log(): console + on-page diagnostic log (long-press the status strip)
 *  - requestToken(): asks the control plane for a LiveKit token
 *  - helpers for the pairing key in the URL fragment and the per-device id
 */
(function () {
  const Petcam = (window.Petcam = window.Petcam || {});

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
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const start = () => {
      cancel();
      timer = setTimeout(() => modal.classList.remove('hidden'), 800);
    };
    strip.addEventListener('mousedown', start);
    strip.addEventListener('mouseup', cancel);
    strip.addEventListener('mouseleave', cancel);
    strip.addEventListener('touchstart', start, { passive: true });
    strip.addEventListener('touchend', cancel);
    strip.addEventListener('touchcancel', cancel);
    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));
  }

  // ------------------------------------------------------------- key / id

  /**
   * Pull `#key=...` out of the URL (QR pairing), store it and scrub the address bar.
   *
   * The key lives in localStorage. Safari deletes script-written storage for a
   * site after seven days of Safari use without interacting with it (a page
   * added to the Home Screen is exempt), so the pages rewrite the key on every
   * connect and the README tells users to add the page to the Home Screen.
   */
  function takeKeyFromFragment(storageKey) {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const key = (params.get('key') || '').trim();
    if (key.length < 32) return null;
    storeKey(storageKey, key);
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
      /* private mode: the value still works for this page load */
    }
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
    return Math.random().toString(36).slice(2, 14);
  }

  /** Stable id per browser so a reload replaces the old session instead of adding one. */
  function getDeviceId(storageKey) {
    let id = readStoredKey(storageKey);
    if (!id) {
      id = 'dev_' + randomId();
      storeKey(storageKey, id);
    }
    return id;
  }

  // ---------------------------------------------------------------- token

  const TOKEN_MESSAGES = {
    wrong_key: 'The server rejected this key. Scan the QR code again (the server owner can print it with show-pairing.sh) or ask the server owner for the key.',
    too_many_viewers: 'Too many people are watching right now. Try again in a moment.',
    bad_request: 'The app sent a request the server did not understand. Reload the page.',
    network: 'Could not reach the Petcam server. Check your internet connection and try again.',
    server: 'The Petcam server had a problem. Try again in a moment.',
  };

  /**
   * Ask the control plane for a LiveKit token.
   * @param {'camera' | 'viewer'} role
   * @param {string} key
   * @param {string} deviceId
   * @returns {Promise<{url: string, token: string, room: string, identity: string, ttl_seconds: number}>}
   */
  async function requestToken(role, key, deviceId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, key, device_id: deviceId }),
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw tokenError('network', err && err.message);
    }
    clearTimeout(timer);

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (res.ok && body && body.token && body.url) {
      log('info', `Token issued for ${role} as ${body.identity} (room ${body.room})`);
      return body;
    }
    const code = (body && body.error) || (res.status === 401 ? 'wrong_key' : res.status === 409 ? 'too_many_viewers' : res.status === 400 ? 'bad_request' : 'server');
    throw tokenError(code, `HTTP ${res.status}`);
  }

  function tokenError(code, detail) {
    const err = new Error(TOKEN_MESSAGES[code] || TOKEN_MESSAGES.server);
    err.code = code;
    err.detail = detail || '';
    return err;
  }

  // -------------------------------------------------------------- helpers

  /** Plain-English text for a getUserMedia / LiveKit media error. */
  function friendlyMediaError(err) {
    if (!err) return 'Unknown camera error.';
    const name = err.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera permission was denied. Reload the page and tap Allow when the browser asks.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No usable camera was found. Try the other lens.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'Another app is using the camera. Close it and try again.';
    }
    return `Camera error: ${name ? name + ': ' : ''}${err.message || String(err)}`;
  }

  function formatBitrate(bitsPerSecond) {
    if (!bitsPerSecond || bitsPerSecond <= 0) return '–';
    if (bitsPerSecond >= 1_000_000) return (bitsPerSecond / 1_000_000).toFixed(1) + ' Mbps';
    return Math.round(bitsPerSecond / 1000) + ' kbps';
  }

  Petcam.log = log;
  Petcam.initDiagnosticsUI = initDiagnosticsUI;
  Petcam.takeKeyFromFragment = takeKeyFromFragment;
  Petcam.readStoredKey = readStoredKey;
  Petcam.storeKey = storeKey;
  Petcam.getDeviceId = getDeviceId;
  Petcam.randomId = randomId;
  Petcam.requestToken = requestToken;
  Petcam.friendlyMediaError = friendlyMediaError;
  Petcam.formatBitrate = formatBitrate;
  Petcam.LK = window.LivekitClient || null;

  if (!Petcam.LK) {
    log('error', 'LiveKit client did not load (static/js/vendor/livekit-client.umd.js)');
  }

  document.addEventListener('DOMContentLoaded', initDiagnosticsUI);
})();
