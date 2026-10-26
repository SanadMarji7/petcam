// @ts-check
'use strict';

/**
 * Petcam publisher page (/cam) for the iPad.
 *
 * One RTCPeerConnection per viewer. The publisher always creates the offer, so
 * ICE restarts are one-directional and the iPad stays in control of its tracks.
 * Every offer carries a random `session` id: viewers answer with the same id, and
 * answers/candidates for an old session are ignored instead of corrupting a
 * newer connection.
 */
(function () {
  const P = window.Petcam;
  const log = P.log;

  const KEY_STORAGE = 'petcam_publisher_key';
  const DEVICE_STORAGE = 'petcam_publisher_device_id';
  const QUALITY = {
    auto: { maxBitrate: 800000, maxFramerate: 15 },
    high: { maxBitrate: 2000000, maxFramerate: 30 },
  };
  const AUTO_SCREEN_OFF_MS = 60000;
  const WATCHDOG_INTERVAL_MS = 5000;
  const STALL_SECONDS = 15; // framesEncoded flat for this long (with viewers) => re-acquire camera
  const ICE_DISCONNECT_GRACE_MS = 5000;
  const ICE_RESTART_GIVE_UP_MS = 15000;

  // DOM
  const $ = (id) => document.getElementById(id);
  const localVideo = /** @type {HTMLVideoElement} */ ($('local-video'));
  const setupCard = $('setup-card');
  const keySection = $('key-section');
  const keyInput = /** @type {HTMLInputElement} */ ($('key-input'));
  const keyError = $('key-error-msg');
  const controlsSection = $('controls-section');
  const cameraSelect = /** @type {HTMLSelectElement} */ ($('camera-select'));
  const startBtn = $('start-cam-btn');
  const startError = $('start-error-msg');
  const wakeLockWarning = $('wake-lock-warning');
  const screenOffBtn = $('screen-off-btn');
  const screenOffOverlay = $('screen-off-overlay');
  const forgetKeyBtn = $('forget-key-btn');
  const replacedCard = $('replaced-card');
  const resumeBtn = $('resume-btn');
  const statusDot = $('status-dot');
  const footer = $('publisher-footer');
  const streamStatus = $('stream-status');
  const viewerCountEl = $('viewer-count');
  const statResolution = $('stat-resolution');
  const statUptime = $('stat-uptime');

  // State
  let publisherKey = P.takeKeyFromFragment(KEY_STORAGE) || P.readStoredKey(KEY_STORAGE);
  const deviceId = P.getDeviceId(DEVICE_STORAGE);
  /** @type {RTCIceServer[]} */
  let iceServers = [];
  let iceServersLoaded = false;
  /** @type {MediaStream | null} */
  let localStream = null;
  /** @type {InstanceType<typeof P.SignalingClient> | null} */
  let signaling = null;
  /** @type {Map<string, Peer>} */
  const peers = new Map();

  let wakeLock = null;
  let watchdogTimer = null;
  let uptimeTimer = null;
  let autoScreenOffTimer = null;
  let startTime = 0;
  let lastFramesEncoded = 0;
  let stuckSeconds = 0;
  let recovering = false;

  /**
   * @typedef {Object} Peer
   * @property {RTCPeerConnection} pc
   * @property {string} session
   * @property {'auto' | 'high'} quality
   * @property {RTCIceCandidateInit[]} pending
   * @property {any} disconnectTimer
   * @property {any} restartTimer
   * @property {boolean} loggedPair
   */

  // ------------------------------------------------------------------ init

  function init() {
    showKeyUI(!publisherKey);

    $('save-key-btn')?.addEventListener('click', handleSaveKey);
    keyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveKey();
    });
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    startBtn?.addEventListener('click', startCamera);
    screenOffBtn?.addEventListener('click', showScreenOff);
    screenOffOverlay?.addEventListener('click', hideScreenOff);
    resumeBtn?.addEventListener('click', () => {
      replacedCard?.classList.add('hidden');
      if (signaling) signaling.reconnectNow();
    });

    document.addEventListener('touchstart', resetAutoScreenOff, { passive: true });
    document.addEventListener('mousemove', resetAutoScreenOff);
    document.addEventListener('visibilitychange', onVisibilityChange);

    P.loadIceServers().then((servers) => {
      iceServers = servers;
      iceServersLoaded = true;
    });
  }

  function showKeyUI(show) {
    keySection?.classList.toggle('hidden', !show);
    controlsSection?.classList.toggle('hidden', show);
  }

  function handleSaveKey() {
    const value = (keyInput?.value || '').trim();
    if (value.length < 32) {
      showBanner(keyError, 'The key must be at least 32 characters. Copy it from config.toml on the server.');
      return;
    }
    publisherKey = value;
    P.storeKey(KEY_STORAGE, value);
    keyError?.classList.add('hidden');
    showKeyUI(false);
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

  function showBanner(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  // --------------------------------------------------------------- capture

  async function acquireStream(facingMode) {
    const facing = { ideal: facingMode || 'environment' };
    const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
    // 720p first, then 480p, then whatever the device offers.
    const ladder = [
      { name: '720p', constraints: { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } }, audio } },
      { name: '480p', constraints: { video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: true } },
      { name: 'default', constraints: { video: true, audio: true } },
    ];
    let lastError = null;
    for (const attempt of ladder) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        const settings = stream.getVideoTracks()[0]?.getSettings() || {};
        log('info', `Camera acquired (${attempt.name}): ${settings.width}x${settings.height} @ ${settings.frameRate || '?'} fps`);
        return stream;
      } catch (err) {
        lastError = err;
        log('warn', `getUserMedia ${attempt.name} failed: ${err.name}: ${err.message}`);
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break;
      }
    }
    throw lastError || new Error('No camera available');
  }

  function explainCameraError(err) {
    if (!err) return 'Unknown camera error.';
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Camera permission was denied. Reload the page and tap Allow when Safari asks.';
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      return 'No usable camera was found. Try the other lens.';
    }
    if (err.name === 'NotReadableError' || err.name === 'AbortError') {
      return 'Another app is using the camera. Close it and try again.';
    }
    return `Camera error: ${err.name}: ${err.message}`;
  }

  async function startCamera() {
    startError?.classList.add('hidden');
    startBtn.disabled = true;
    try {
      localStream = await acquireStream(cameraSelect?.value || 'environment');
      watchTracks(localStream);
      localVideo.srcObject = localStream;
      localVideo.muted = true;
      await localVideo.play().catch(() => {});

      setupCard?.classList.add('hidden');
      footer?.classList.remove('hidden');
      screenOffBtn?.classList.remove('hidden');
      setStreamStatus('Connecting', 'connecting');

      await requestWakeLock(); // inside the tap handler: Safari needs a user gesture
      if (!iceServersLoaded) {
        iceServers = await P.loadIceServers();
        iceServersLoaded = true;
      }
      connectSignaling();

      startTime = Date.now();
      startWatchdog();
      resetAutoScreenOff();
    } catch (err) {
      startBtn.disabled = false;
      log('error', `Start failed: ${err.message}`);
      showBanner(startError, explainCameraError(err));
    }
  }

  function watchTracks(stream) {
    for (const track of stream.getTracks()) {
      track.onended = () => {
        log('warn', `${track.kind} track ended by the system`);
        recoverCamera('track ended');
      };
    }
  }

  // ------------------------------------------------------------- wake lock

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      log('warn', 'Wake Lock API not available (needs iOS 16.4+)');
      wakeLockWarning?.classList.remove('hidden');
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => log('info', 'Wake lock released'));
      log('info', 'Wake lock active');
    } catch (err) {
      log('warn', `Wake lock failed: ${err.message}`);
      wakeLockWarning?.classList.remove('hidden');
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible' || !localStream) return;
    // Safari releases the wake lock and may have frozen the camera while hidden.
    log('info', 'Page visible again: renewing wake lock and checking the camera');
    requestWakeLock();
    checkHealth();
  }

  // ------------------------------------------------------------ screen off

  function showScreenOff() {
    screenOffOverlay?.classList.remove('hidden');
  }

  function hideScreenOff() {
    screenOffOverlay?.classList.add('hidden');
    resetAutoScreenOff();
  }

  function resetAutoScreenOff() {
    if (autoScreenOffTimer) clearTimeout(autoScreenOffTimer);
    autoScreenOffTimer = null;
    if (localStream) autoScreenOffTimer = setTimeout(showScreenOff, AUTO_SCREEN_OFF_MS);
  }

  // ------------------------------------------------------------- signaling

  function connectSignaling() {
    signaling = new P.SignalingClient({
      role: 'publisher',
      getKey: () => publisherKey,
      getDeviceId: () => deviceId,
      onOpen: (_id, reconnected) => {
        if (reconnected) {
          // The server tells every viewer "publisher_changed"; they will re-join
          // and get fresh offers, so drop the old connections now.
          closeAllPeers('signaling reconnected');
        }
        setStreamStatus('Streaming', 'online');
      },
      onClose: () => setStreamStatus('Reconnecting', 'connecting'),
      onAuthFailed: (reason) => {
        log('error', `Key rejected: ${reason}`);
        P.storeKey(KEY_STORAGE, '');
        publisherKey = '';
        stopEverything();
        setupCard?.classList.remove('hidden');
        showKeyUI(true);
        showBanner(keyError, 'The server rejected this key. Scan the iPad QR code again or paste the publisher key.');
      },
      onReplaced: () => {
        closeAllPeers('replaced by another publisher');
        setStreamStatus('Replaced', 'error');
        replacedCard?.classList.remove('hidden');
      },
      onMessage: enqueueMessage,
    });
    signaling.connect();
  }

  // Messages are handled one at a time, in order: an 'answer' must be fully
  // applied before the 'viewer_restart' or 'ice' that follows it is looked at.
  let messageChain = Promise.resolve();
  function enqueueMessage(msg) {
    messageChain = messageChain
      .then(() => handleMessage(msg))
      .catch((err) => log('error', `Signaling handler failed for '${msg && msg.type}': ${err.message}`));
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'viewer_joined':
        log('info', `Viewer [${msg.viewer_id}] joined`);
        await createPeer(msg.viewer_id);
        break;
      case 'answer':
        await onAnswer(msg.viewer_id, msg.session, msg.sdp);
        break;
      case 'ice':
        await onRemoteCandidate(msg.viewer_id, msg.session, msg.candidate);
        break;
      case 'viewer_restart':
        log('info', `Viewer [${msg.viewer_id}] asked for an ICE restart`);
        await iceRestart(msg.viewer_id, 'viewer request');
        break;
      case 'viewer_quality':
        onViewerQuality(msg.viewer_id, msg.quality);
        break;
      case 'viewer_left':
        log('info', `Viewer [${msg.viewer_id}] left`);
        closePeer(msg.viewer_id);
        break;
      default:
        log('warn', `Unknown signaling message '${msg.type}'`);
    }
  }

  // ----------------------------------------------------------------- peers

  async function createPeer(viewerId) {
    if (!localStream) {
      log('warn', `No camera stream yet; ignoring viewer [${viewerId}]`);
      return;
    }
    closePeer(viewerId);

    const pc = new RTCPeerConnection(P.rtcConfig(iceServers));
    /** @type {Peer} */
    const peer = { pc, session: P.randomId(), quality: 'auto', pending: [], disconnectTimer: null, restartTimer: null, loggedPair: false };
    peers.set(viewerId, peer);

    for (const track of localStream.getTracks()) {
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [localStream] });
      if (track.kind === 'video') preferH264(transceiver);
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate || !signaling) return; // skip end-of-candidates
      log('info', `[${viewerId}] local candidate: ${P.describeCandidate(event.candidate)}`);
      signaling.send({ type: 'ice', viewer_id: viewerId, session: peer.session, candidate: event.candidate.toJSON() });
    };

    pc.oniceconnectionstatechange = () => {
      if (peers.get(viewerId) !== peer) return;
      const state = pc.iceConnectionState;
      log('info', `[${viewerId}] ICE ${state}`);
      if (state === 'connected' || state === 'completed') {
        clearPeerTimers(peer);
        if (!peer.loggedPair) {
          peer.loggedPair = true;
          P.describeSelectedPair(pc).then((pair) => pair && log('info', `[${viewerId}] media path: ${pair}`));
        }
      } else if (state === 'disconnected') {
        if (!peer.disconnectTimer) {
          peer.disconnectTimer = setTimeout(() => {
            peer.disconnectTimer = null;
            if (pc.iceConnectionState === 'disconnected') iceRestart(viewerId, 'still disconnected after grace period');
          }, ICE_DISCONNECT_GRACE_MS);
        }
      } else if (state === 'failed') {
        iceRestart(viewerId, 'ICE failed');
      }
      updateViewerCount();
    };

    pc.onconnectionstatechange = () => {
      if (peers.get(viewerId) !== peer) return;
      log('info', `[${viewerId}] connection ${pc.connectionState}`);
      updateViewerCount();
    };

    await sendOffer(viewerId, peer, false);
  }

  async function sendOffer(viewerId, peer, iceRestart) {
    const pc = peer.pc;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
      if (peers.get(viewerId) !== peer || pc.signalingState === 'closed') return;
      await pc.setLocalDescription(offer);
      if (!signaling || !signaling.send({ type: 'offer', viewer_id: viewerId, session: peer.session, restart: iceRestart, sdp: pc.localDescription.sdp })) {
        log('warn', `[${viewerId}] offer not sent (signaling down); the viewer will re-join`);
        return;
      }
      log('info', `[${viewerId}] sent ${iceRestart ? 'ICE-restart ' : ''}offer (session ${peer.session})`);
      await applyEncoding(peer); // encodings exist only after setLocalDescription
    } catch (err) {
      log('error', `[${viewerId}] offer failed: ${err.message}`);
    }
  }

  async function onAnswer(viewerId, session, sdp) {
    const peer = peers.get(viewerId);
    if (!peer || peer.session !== session) {
      log('warn', `[${viewerId}] ignored answer for stale session ${session}`);
      return;
    }
    if (peer.pc.signalingState !== 'have-local-offer') {
      log('warn', `[${viewerId}] ignored answer in state ${peer.pc.signalingState}`);
      return;
    }
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      log('info', `[${viewerId}] remote answer applied`);
      await flushPending(viewerId, peer);
    } catch (err) {
      log('error', `[${viewerId}] setRemoteDescription(answer) failed: ${err.message}; re-offering`);
      await createPeer(viewerId);
    }
  }

  async function onRemoteCandidate(viewerId, session, candidate) {
    const peer = peers.get(viewerId);
    if (!peer || peer.session !== session || !candidate || !candidate.candidate) return;
    log('info', `[${viewerId}] remote candidate: ${P.describeCandidate(candidate)}`);
    if (!peer.pc.remoteDescription) {
      peer.pending.push(candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      log('warn', `[${viewerId}] addIceCandidate failed: ${err.message}`);
    }
  }

  async function flushPending(viewerId, peer) {
    const queued = peer.pending.splice(0);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        log('warn', `[${viewerId}] queued candidate rejected: ${err.message}`);
      }
    }
    if (queued.length) log('info', `[${viewerId}] applied ${queued.length} queued candidate(s)`);
  }

  async function iceRestart(viewerId, reason) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    if (peer.restartTimer) return; // one restart at a time
    if (peer.pc.signalingState !== 'stable' || peer.pc.connectionState === 'closed') {
      log('info', `[${viewerId}] ${reason}: connection not stable, building a new one`);
      await createPeer(viewerId);
      return;
    }
    log('info', `[${viewerId}] ICE restart (${reason})`);
    peer.restartTimer = setTimeout(() => {
      peer.restartTimer = null;
      const s = peer.pc.iceConnectionState;
      if (peers.get(viewerId) === peer && s !== 'connected' && s !== 'completed') {
        log('warn', `[${viewerId}] ICE restart did not recover; building a new connection`);
        createPeer(viewerId);
      }
    }, ICE_RESTART_GIVE_UP_MS);
    await sendOffer(viewerId, peer, true);
  }

  function onViewerQuality(viewerId, quality) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    peer.quality = quality === 'high' ? 'high' : 'auto';
    applyEncoding(peer);
  }

  async function applyEncoding(peer) {
    const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const q = QUALITY[peer.quality];
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) return;
      params.encodings[0].maxBitrate = q.maxBitrate;
      params.encodings[0].maxFramerate = q.maxFramerate;
      await sender.setParameters(params);
      log('info', `Encoding ${peer.quality}: ${q.maxBitrate / 1000} kbps, ${q.maxFramerate} fps`);
    } catch (err) {
      log('warn', `setParameters failed: ${err.message}`);
    }
  }

  function preferH264(transceiver) {
    if (typeof transceiver.setCodecPreferences !== 'function') return;
    const caps =
      (window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video')) ||
      (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video'));
    if (!caps || !caps.codecs) return;
    const isH264 = (c) => /h264/i.test(c.mimeType);
    const h264 = caps.codecs.filter(isH264);
    if (h264.length === 0) return;
    try {
      // H.264 first so the iPad uses its hardware encoder; VP8 etc. stay as fallbacks.
      transceiver.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !isH264(c))]);
    } catch (err) {
      log('warn', `setCodecPreferences failed: ${err.message}`);
    }
  }

  function clearPeerTimers(peer) {
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.disconnectTimer = null;
    peer.restartTimer = null;
  }

  function closePeer(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    peers.delete(viewerId);
    clearPeerTimers(peer);
    peer.pc.onicecandidate = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch (_) {
      /* ignore */
    }
    updateViewerCount();
  }

  function closeAllPeers(reason) {
    if (peers.size) log('info', `Closing ${peers.size} viewer connection(s): ${reason}`);
    for (const viewerId of Array.from(peers.keys())) closePeer(viewerId);
  }

  function stopEverything() {
    closeAllPeers('stopped');
    if (signaling) signaling.close();
    signaling = null;
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (uptimeTimer) clearInterval(uptimeTimer);
    if (autoScreenOffTimer) clearTimeout(autoScreenOffTimer);
    watchdogTimer = uptimeTimer = autoScreenOffTimer = null;
    footer?.classList.add('hidden');
    screenOffBtn?.classList.add('hidden');
    startBtn.disabled = false;
  }

  // -------------------------------------------------------------- watchdog

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (uptimeTimer) clearInterval(uptimeTimer);
    watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
    uptimeTimer = setInterval(updateUptime, 1000);
  }

  async function checkHealth() {
    if (!localStream || recovering) return;
    if (document.visibilityState === 'hidden') return; // Safari froze us; wait until visible

    const trackEnded = localStream.getTracks().some((t) => t.readyState === 'ended');

    let framesEncoded = 0;
    let connected = 0;
    for (const [, peer] of peers) {
      const s = peer.pc.iceConnectionState;
      if (s !== 'connected' && s !== 'completed') continue;
      connected += 1;
      const stats = await P.readVideoStats(peer.pc, 'outbound');
      framesEncoded += stats.frames;
      if (stats.width && statResolution) statResolution.textContent = `${stats.width}x${stats.height} @ ${stats.fps}fps`;
    }

    if (connected > 0) {
      if (framesEncoded === lastFramesEncoded) stuckSeconds += WATCHDOG_INTERVAL_MS / 1000;
      else stuckSeconds = 0;
      lastFramesEncoded = framesEncoded;
    } else {
      stuckSeconds = 0;
      lastFramesEncoded = 0;
      if (statResolution) {
        const settings = localStream.getVideoTracks()[0]?.getSettings();
        if (settings && settings.width) statResolution.textContent = `${settings.width}x${settings.height}`;
      }
    }
    updateViewerCount();

    if (trackEnded || stuckSeconds >= STALL_SECONDS) {
      await recoverCamera(trackEnded ? 'a track ended' : `no frames encoded for ${stuckSeconds}s`);
    }
  }

  async function recoverCamera(reason) {
    if (recovering || !localStream) return;
    if (document.visibilityState === 'hidden') return;
    recovering = true;
    log('warn', `Recovering camera: ${reason}`);
    setStreamStatus('Recovering', 'connecting');
    try {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = await acquireStream(cameraSelect?.value || 'environment');
      watchTracks(localStream);
      localVideo.srcObject = localStream;
      await localVideo.play().catch(() => {});

      const video = localStream.getVideoTracks()[0];
      const audio = localStream.getAudioTracks()[0];
      const failed = [];
      for (const [viewerId, peer] of peers) {
        try {
          for (const sender of peer.pc.getSenders()) {
            if (!sender.track) continue;
            if (sender.track.kind === 'video' && video) await sender.replaceTrack(video);
            if (sender.track.kind === 'audio' && audio) await sender.replaceTrack(audio);
          }
        } catch (err) {
          log('warn', `[${viewerId}] replaceTrack failed: ${err.message}`);
          failed.push(viewerId);
        }
      }
      for (const viewerId of failed) await createPeer(viewerId);
      stuckSeconds = 0;
      lastFramesEncoded = 0;
      setStreamStatus(signaling && signaling.isOpen ? 'Streaming' : 'Reconnecting', signaling && signaling.isOpen ? 'online' : 'connecting');
      log('info', 'Camera recovered');
    } catch (err) {
      log('error', `Camera recovery failed: ${err.message}`);
      setStreamStatus('Camera error', 'error');
    } finally {
      recovering = false;
    }
  }

  // ---------------------------------------------------------------- status

  function setStreamStatus(text, kind) {
    if (streamStatus) {
      streamStatus.textContent = text;
      streamStatus.className = 'val ' + (kind === 'online' ? 'val-online' : kind === 'error' ? 'val-error' : 'val-connecting');
    }
    statusDot?.classList.remove('online', 'connecting', 'error');
    statusDot?.classList.add(kind);
  }

  function updateViewerCount() {
    if (!viewerCountEl) return;
    let connected = 0;
    for (const [, peer] of peers) {
      const s = peer.pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') connected += 1;
    }
    viewerCountEl.textContent = peers.size > connected ? `${connected} (+${peers.size - connected} connecting)` : String(connected);
  }

  function updateUptime() {
    if (!startTime || !statUptime) return;
    const s = Math.floor((Date.now() - startTime) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    statUptime.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
