// @ts-check
'use strict';

/**
 * Petcam viewer page (/watch) for a Pixel, iPhone or laptop.
 *
 * Flow: open WebSocket -> auth -> join -> wait for the publisher's offer ->
 * answer -> live. Every offer carries a `session` id. A plain offer always
 * starts a fresh RTCPeerConnection; an offer flagged `restart` is an ICE
 * restart and is applied to the existing connection with the same session.
 * The watchdog re-sends `join` when no offer arrives and rebuilds when media
 * stalls, so the page recovers without anyone tapping it.
 */
(function () {
  const P = window.Petcam;
  const log = P.log;

  const KEY_STORAGE = 'petcam_viewer_key';
  const DEVICE_STORAGE = 'petcam_device_id';
  const WATCHDOG_INTERVAL_MS = 2000;
  const OFFER_TIMEOUT_MS = 8000; // no offer after join -> join again
  const CONNECT_TIMEOUT_MS = 20000; // answered but ICE never connected -> rebuild
  const STUCK_RESTART_SECONDS = 8; // frames flat -> ask for ICE restart
  const STUCK_REBUILD_SECONDS = 18; // still flat -> rebuild from a new offer
  const ICE_DISCONNECT_GRACE_MS = 5000;
  const MAX_FAILURES_BEFORE_BACKOFF = 3;
  const BACKOFF_SECONDS = 30;

  // DOM
  const $ = (id) => document.getElementById(id);
  const videoWrapper = $('video-wrapper');
  const remoteVideo = /** @type {HTMLVideoElement} */ ($('remote-video'));
  const keyCard = $('key-card');
  const keyInput = /** @type {HTMLInputElement} */ ($('key-input'));
  const authError = $('auth-error-msg');
  const forgetKeyBtn = $('forget-key-btn');
  const offlineBanner = $('offline-banner');
  const playOverlay = $('play-overlay');
  const audioToggleBtn = $('audio-toggle-btn');
  const audioIcon = $('audio-icon');
  const audioText = $('audio-text');
  const qualityModeText = $('quality-mode-text');
  const statusDot = $('status-dot');
  const connStateEl = $('conn-state');
  const iceStateEl = $('ice-state');
  const feedStatsEl = $('feed-stats');

  // State
  let viewerKey = P.takeKeyFromFragment(KEY_STORAGE) || P.readStoredKey(KEY_STORAGE);
  const deviceId = P.getDeviceId(DEVICE_STORAGE);
  /** @type {RTCIceServer[]} */
  let iceServers = [];
  /** @type {InstanceType<typeof P.SignalingClient> | null} */
  let signaling = null;
  /** @type {RTCPeerConnection | null} */
  let pc = null;
  let session = null;
  /** @type {RTCIceCandidateInit[]} */
  let pending = [];
  let publisherOnline = false;
  let quality = 'auto';

  let joinSentAt = 0;
  let joinAttempts = 0;
  let answeredAt = 0;
  let lastFramesDecoded = 0;
  let stuckSeconds = 0;
  let restartRequested = false;
  let failures = 0;
  let watchdogTimer = null;
  let disconnectTimer = null;
  let backoffTimer = null;
  let loggedPair = false;

  // ------------------------------------------------------------------ init

  async function init() {
    keyCard?.classList.toggle('hidden', !!viewerKey);

    $('save-key-btn')?.addEventListener('click', handleSaveKey);
    keyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveKey();
    });
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    audioToggleBtn?.addEventListener('click', toggleAudio);
    $('quality-toggle-btn')?.addEventListener('click', toggleQuality);
    $('reconnect-btn')?.addEventListener('click', () => {
      failures = 0;
      cancelBackoff();
      if (signaling && signaling.isOpen) rebuild('reconnect button');
      else if (signaling) signaling.reconnectNow();
      else connectSignaling();
    });
    initShareQr();
    initFullscreenTap();

    playOverlay?.addEventListener('click', () => {
      remoteVideo.play().then(() => playOverlay.classList.add('hidden')).catch(() => {});
    });
    remoteVideo?.addEventListener('playing', () => playOverlay?.classList.add('hidden'));

    window.addEventListener('online', () => {
      log('info', 'Network is back');
      if (signaling && !signaling.isOpen) signaling.reconnectNow();
      else if (pc && !isLive()) requestIceRestart('network changed');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (signaling && !signaling.isOpen) signaling.reconnectNow();
      else if (pc && !isLive()) requestIceRestart('page visible again');
      else if (remoteVideo.paused && remoteVideo.srcObject) remoteVideo.play().catch(() => {});
    });

    iceServers = await P.loadIceServers();
    if (viewerKey) connectSignaling();
  }

  function handleSaveKey() {
    const value = (keyInput?.value || '').trim();
    if (value.length < 32) {
      showAuthError('The key must be at least 32 characters. Copy it from config.toml on the server.');
      return;
    }
    viewerKey = value;
    P.storeKey(KEY_STORAGE, value);
    authError?.classList.add('hidden');
    keyCard?.classList.add('hidden');
    if (signaling) signaling.reconnectNow();
    else connectSignaling();
  }

  let forgetArmed = false;
  function handleForgetKey() {
    if (!forgetArmed) {
      forgetArmed = true;
      forgetKeyBtn.textContent = 'Tap again to forget';
      setTimeout(() => {
        forgetArmed = false;
        forgetKeyBtn.textContent = 'Forget key';
      }, 3000);
      return;
    }
    P.storeKey(KEY_STORAGE, '');
    window.location.reload();
  }

  function showAuthError(text) {
    if (!authError) return;
    authError.textContent = text;
    authError.classList.remove('hidden');
  }

  // -------------------------------------------------------------- controls

  function toggleAudio() {
    remoteVideo.muted = !remoteVideo.muted;
    if (!remoteVideo.muted) remoteVideo.play().catch(() => {});
    if (audioIcon) audioIcon.textContent = remoteVideo.muted ? '🔇' : '🔊';
    if (audioText) audioText.textContent = remoteVideo.muted ? 'Unmute' : 'Mute';
    audioToggleBtn?.setAttribute('aria-label', remoteVideo.muted ? 'Unmute audio' : 'Mute audio');
  }

  function toggleQuality() {
    quality = quality === 'auto' ? 'high' : 'auto';
    if (qualityModeText) qualityModeText.textContent = quality === 'high' ? 'High' : 'Auto';
    if (signaling && signaling.isOpen && pc) signaling.send({ type: 'quality', quality });
  }

  let lastTap = 0;
  function initFullscreenTap() {
    remoteVideo?.addEventListener('click', () => {
      const now = Date.now();
      const doubleTap = now - lastTap < 300;
      lastTap = now;
      if (doubleTap) return;
      if (!document.fullscreenElement) {
        if (videoWrapper?.requestFullscreen) videoWrapper.requestFullscreen().catch(() => {});
        else if (remoteVideo.webkitEnterFullscreen) remoteVideo.webkitEnterFullscreen(); // iOS Safari
      } else if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  function initShareQr() {
    const modal = $('qr-modal');
    const display = $('qr-code-display');
    const link = $('qr-link-copy');
    $('share-qr-btn')?.addEventListener('click', async () => {
      if (!viewerKey) {
        showAuthError('Enter the viewer key first.');
        keyCard?.classList.remove('hidden');
        return;
      }
      modal?.classList.remove('hidden');
      if (display) display.innerHTML = '';
      if (link) link.textContent = `${window.location.origin}/watch#key=${viewerKey}`;
      try {
        // The server draws the QR code; the key in the header proves we already have it.
        const res = await fetch('/qr/watch.svg', { headers: { 'X-Petcam-Key': viewerKey }, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (display) display.innerHTML = await res.text();
      } catch (err) {
        log('warn', `QR code unavailable: ${err.message}`);
        if (display) display.innerHTML = '<p class="qr-error">Could not load the QR code. Use the link below instead.</p>';
      }
    });
    $('close-qr-btn')?.addEventListener('click', () => modal?.classList.add('hidden'));
  }

  // ------------------------------------------------------------- signaling

  function connectSignaling() {
    setState('Connecting', 'connecting');
    signaling = new P.SignalingClient({
      role: 'viewer',
      getKey: () => viewerKey,
      getDeviceId: () => deviceId,
      onOpen: () => {
        failures = 0;
        cancelBackoff();
        rebuild('signaling connected');
      },
      onClose: () => {
        if (!backoffTimer) setState('Reconnecting', 'connecting');
      },
      onAuthFailed: (reason) => {
        setState('Wrong key', 'error');
        showAuthError('The server rejected this key. Scan the phone QR code again or paste the viewer key.');
        keyCard?.classList.remove('hidden');
      },
      onReplaced: () => {
        closePeer();
        setState('Opened elsewhere', 'error');
        showAuthError('This phone opened the stream in another tab or window. Close this one, or tap Reconnect to watch here.');
        keyCard?.classList.remove('hidden');
      },
      onViewerLimit: () => setState('Viewer limit reached', 'error'),
      onMessage: enqueueMessage,
    });
    signaling.connect();
    startWatchdog();
  }

  // Messages are handled one at a time, in order, so an 'offer' is fully
  // answered before the next 'ice' or 'offer' is looked at.
  let messageChain = Promise.resolve();
  function enqueueMessage(msg) {
    messageChain = messageChain
      .then(() => handleMessage(msg))
      .catch((err) => log('error', `Signaling handler failed for '${msg && msg.type}': ${err.message}`));
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'publisher_online':
        publisherOnline = true;
        offlineBanner?.classList.add('hidden');
        if (!isLive()) setState('Camera online, connecting', 'connecting');
        break;
      case 'publisher_offline':
        publisherOnline = false;
        closePeer();
        offlineBanner?.classList.remove('hidden');
        setState('Camera offline', 'connecting');
        break;
      case 'publisher_changed':
        log('info', 'Publisher reconnected; joining again');
        rebuild('publisher changed');
        break;
      case 'offer':
        await handleOffer(msg);
        break;
      case 'ice':
        await handleRemoteCandidate(msg);
        break;
      case 'error':
        if (msg.reason === 'too_many_viewers') setState('Viewer limit reached', 'error');
        break;
      default:
        log('warn', `Unknown signaling message '${msg.type}'`);
    }
  }

  function sendJoin() {
    if (!signaling || !signaling.isOpen) return;
    joinAttempts += 1;
    joinSentAt = Date.now();
    signaling.send({ type: 'join' });
  }

  /** Drop the current connection and ask the publisher for a brand-new offer. */
  function rebuild(reason) {
    log('info', `Requesting a fresh offer (${reason})`);
    closePeer();
    joinAttempts = 0;
    if (signaling && signaling.isOpen) {
      setState('Connecting', 'connecting');
      sendJoin();
    } else if (signaling) {
      signaling.reconnectNow();
    }
  }

  function requestIceRestart(reason) {
    if (!signaling || !signaling.isOpen || !pc) return;
    if (restartRequested) return;
    restartRequested = true;
    log('info', `Requesting ICE restart: ${reason}`);
    signaling.send({ type: 'restart' });
  }

  // ---------------------------------------------------------------- WebRTC

  async function handleOffer(msg) {
    const offerSession = typeof msg.session === 'string' ? msg.session : null;
    try {
      if (msg.restart) {
        if (!pc || !offerSession || offerSession !== session || pc.signalingState !== 'stable') {
          log('warn', 'ICE-restart offer does not match the current connection; joining again');
          rebuild('stale restart offer');
          return;
        }
        log('info', `ICE-restart offer for session ${session}`);
      } else {
        closePeer();
        session = offerSession;
        pc = createPeerConnection();
        log('info', `New offer (session ${session})`);
      }
      const current = pc;
      await current.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      if (pc !== current) return;
      await flushPending(current);
      const answer = await current.createAnswer();
      await current.setLocalDescription(answer);
      if (pc !== current) return;
      signaling.send({ type: 'answer', session, sdp: current.localDescription.sdp });
      answeredAt = Date.now();
      restartRequested = false;
      joinSentAt = 0;
      if (quality === 'high') signaling.send({ type: 'quality', quality: 'high' });
    } catch (err) {
      log('error', `Could not answer the offer: ${err.message}`);
      setState(`Error: ${err.message}`, 'error');
      fail('answer failed');
    }
  }

  function createPeerConnection() {
    const conn = new RTCPeerConnection(P.rtcConfig(iceServers));
    pending = [];
    stuckSeconds = 0;
    lastFramesDecoded = 0;
    loggedPair = false;
    clearDisconnectTimer();

    conn.ontrack = (event) => {
      if (pc !== conn) return;
      log('info', `Remote ${event.track.kind} track received`);
      let stream = event.streams && event.streams[0];
      if (!stream) {
        stream = remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream();
        stream.addTrack(event.track);
      }
      if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
      const playing = remoteVideo.play();
      if (playing) {
        playing
          .then(() => playOverlay?.classList.add('hidden'))
          .catch((err) => {
            if (err.name !== 'AbortError') {
              log('warn', `Autoplay blocked: ${err.message}`);
              playOverlay?.classList.remove('hidden');
            }
          });
      }
    };

    conn.onicecandidate = (event) => {
      if (pc !== conn || !event.candidate || !event.candidate.candidate || !signaling) return; // skip end-of-candidates
      log('info', `Local candidate: ${P.describeCandidate(event.candidate)}`);
      signaling.send({ type: 'ice', session, candidate: event.candidate.toJSON() });
    };

    conn.oniceconnectionstatechange = () => {
      if (pc !== conn) return;
      const state = conn.iceConnectionState;
      if (iceStateEl) iceStateEl.textContent = state;
      log('info', `ICE ${state}`);
      if (state === 'connected' || state === 'completed') {
        clearDisconnectTimer();
        failures = 0;
        restartRequested = false;
        setState('Live', 'online');
        if (!loggedPair) {
          loggedPair = true;
          P.describeSelectedPair(conn).then((pair) => pair && log('info', `Media path: ${pair}`));
        }
      } else if (state === 'disconnected') {
        setState('Reconnecting', 'connecting');
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (pc === conn && conn.iceConnectionState === 'disconnected') requestIceRestart('still disconnected after grace period');
          }, ICE_DISCONNECT_GRACE_MS);
        }
      } else if (state === 'failed') {
        fail('ICE failed');
      }
    };

    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      log('info', `Connection ${conn.connectionState}`);
      if (conn.connectionState === 'failed') fail('connection failed');
    };

    return conn;
  }

  async function handleRemoteCandidate(msg) {
    if (!pc || !msg.candidate || !msg.candidate.candidate) return;
    if (typeof msg.session === 'string' && msg.session !== session) return; // from an older offer
    log('info', `Remote candidate: ${P.describeCandidate(msg.candidate)}`);
    if (!pc.remoteDescription) {
      pending.push(msg.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      log('warn', `addIceCandidate failed: ${err.message}`);
    }
  }

  async function flushPending(conn) {
    const queued = pending.splice(0);
    for (const candidate of queued) {
      try {
        await conn.addIceCandidate(candidate);
      } catch (err) {
        log('warn', `Queued candidate rejected: ${err.message}`);
      }
    }
    if (queued.length) log('info', `Applied ${queued.length} queued candidate(s)`);
  }

  function isLive() {
    if (!pc) return false;
    const s = pc.iceConnectionState;
    return s === 'connected' || s === 'completed';
  }

  function closePeer() {
    clearDisconnectTimer();
    restartRequested = false;
    answeredAt = 0;
    pending = [];
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch (_) {
        /* ignore */
      }
      pc = null;
    }
    session = null;
    remoteVideo.srcObject = null;
    if (iceStateEl) iceStateEl.textContent = 'closed';
    if (feedStatsEl) feedStatsEl.textContent = '–';
  }

  function clearDisconnectTimer() {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  // -------------------------------------------------------------- watchdog

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
  }

  async function checkHealth() {
    if (!signaling || !signaling.isOpen || backoffTimer || !publisherOnline) return;
    const now = Date.now();

    if (!pc) {
      // Joined but no offer yet: ask again, waiting a bit longer each time.
      if (joinSentAt && now - joinSentAt > Math.min(OFFER_TIMEOUT_MS * joinAttempts, 30000)) {
        log('warn', `No offer after ${Math.round((now - joinSentAt) / 1000)}s; joining again`);
        sendJoin();
      }
      return;
    }

    const stats = await P.readVideoStats(pc, 'inbound');
    if (feedStatsEl && (stats.width || stats.fps)) feedStatsEl.textContent = `${stats.width}x${stats.height} @ ${stats.fps}fps`;

    if (!isLive()) {
      if (answeredAt && now - answeredAt > CONNECT_TIMEOUT_MS) fail('ICE never connected');
      return;
    }

    if (stats.frames === lastFramesDecoded) stuckSeconds += WATCHDOG_INTERVAL_MS / 1000;
    else stuckSeconds = 0;
    lastFramesDecoded = stats.frames;

    if (stuckSeconds >= STUCK_REBUILD_SECONDS) {
      fail(`no video for ${stuckSeconds}s`);
    } else if (stuckSeconds >= STUCK_RESTART_SECONDS) {
      setState('Video stalled, recovering', 'connecting');
      requestIceRestart(`no video for ${stuckSeconds}s`);
    }
  }

  function fail(reason) {
    failures += 1;
    stuckSeconds = 0;
    log('warn', `Connection failure #${failures}: ${reason}`);
    if (failures >= MAX_FAILURES_BEFORE_BACKOFF) {
      startBackoff();
      return;
    }
    rebuild(reason);
  }

  function startBackoff() {
    closePeer();
    cancelBackoff();
    let remaining = BACKOFF_SECONDS;
    setState(`Retrying in ${remaining}s`, 'connecting');
    backoffTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setState(`Retrying in ${remaining}s`, 'connecting');
        return;
      }
      cancelBackoff();
      failures = 0;
      rebuild('retry after backoff');
    }, 1000);
  }

  function cancelBackoff() {
    if (backoffTimer) clearInterval(backoffTimer);
    backoffTimer = null;
  }

  function setState(text, kind) {
    if (connStateEl) {
      connStateEl.textContent = text;
      connStateEl.className = 'val ' + (kind === 'online' ? 'val-online' : kind === 'error' ? 'val-error' : 'val-connecting');
    }
    statusDot?.classList.remove('online', 'connecting', 'error');
    statusDot?.classList.add(kind);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
