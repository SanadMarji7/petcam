// @ts-check
'use strict';

/**
 * Petcam Publisher Controller (iPad & Safari optimized)
 * Handles unattended camera capture, multi-viewer WebRTC streaming,
 * hardware H.264 encoding, screen-off battery preservation, and self-healing watchdog.
 */

(function () {
  const { log, SignalingClient, readVideoStats } = window.Petcam;

  // DOM Elements
  const localVideo = /** @type {HTMLVideoElement} */ (document.getElementById('local-video'));
  const setupCard = document.getElementById('setup-card');
  const keySection = document.getElementById('key-section');
  const controlsSection = document.getElementById('controls-section');
  const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key-input'));
  const saveKeyBtn = document.getElementById('save-key-btn');
  const forgetKeyBtn = document.getElementById('forget-key-btn');
  const startCamBtn = document.getElementById('start-cam-btn');
  const cameraSelect = /** @type {HTMLSelectElement} */ (document.getElementById('camera-select'));
  const screenOffBtn = document.getElementById('screen-off-btn');
  const screenOffOverlay = document.getElementById('screen-off-overlay');
  const wakeLockWarning = document.getElementById('wake-lock-warning');
  const startErrorMsg = document.getElementById('start-error-msg');
  const statusDot = document.getElementById('status-dot');

  // Status strip elements
  const publisherFooter = document.getElementById('publisher-footer');
  const streamStatus = document.getElementById('stream-status');
  const viewerCountEl = document.getElementById('viewer-count');
  const statResolution = document.getElementById('stat-resolution');
  const statUptime = document.getElementById('stat-uptime');

  // State
  const STORAGE_KEY = 'petcam_publisher_key';
  let publisherKey = localStorage.getItem(STORAGE_KEY) || '';
  /** @type {MediaStream | null} */
  let localStream = null;
  /** @type {SignalingClient | null} */
  let signaling = null;
  /** @type {Map<string, { pc: RTCPeerConnection, makingOffer: boolean, quality: string }>} */
  const peerConnections = new Map();

  // Watchdog & WakeLock state
  let wakeLock = null;
  let watchdogTimer = null;
  let uptimeTimer = null;
  let autoScreenOffTimer = null;
  let startTime = 0;
  let lastFramesEncoded = 0;
  let framesStuckSeconds = 0;
  let isRecovering = false;
  // Default to public STUN fallback so iOS/Android mDNS anonymized candidates (.local) resolve
  let iceServersConfig = [{ urls: 'stun:stun.l.google.com:19302' }];

  // 1. Initialization and Key Management
  function init() {
    // Check if key is provided via URL fragment (e.g. from QR code scan: /cam#key=...)
    if (window.location.hash) {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const urlKey = params.get('key') || (hash.length >= 32 && !hash.includes('=') ? hash : null);
      if (urlKey && urlKey.length >= 32) {
        publisherKey = urlKey;
        localStorage.setItem(STORAGE_KEY, publisherKey);
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
        log('info', 'Publisher key imported seamlessly from QR code link');
      }
    }

    if (publisherKey) {
      keySection?.classList.add('hidden');
      controlsSection?.classList.remove('hidden');
    } else {
      keySection?.classList.remove('hidden');
      controlsSection?.classList.add('hidden');
    }

    saveKeyBtn?.addEventListener('click', handleSaveKey);
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    startCamBtn?.addEventListener('click', handleStartCamera);
    screenOffBtn?.addEventListener('click', showScreenOffOverlay);
    screenOffOverlay?.addEventListener('click', hideScreenOffOverlay);

    // Any touch on screen resets the 60s auto-screen-off countdown
    document.addEventListener('touchstart', resetAutoScreenOffTimer, { passive: true });
    document.addEventListener('mousemove', resetAutoScreenOffTimer);

    // Fetch server ICE configuration (STUN fallback if enabled)
    fetch('/config.json')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.ice_servers) && data.ice_servers.length > 0) {
          iceServersConfig = data.ice_servers;
          log('info', `Loaded ICE server configuration (${iceServersConfig.length} servers)`);
        }
      })
      .catch(() => {
        log('info', 'Using built-in STUN fallback');
      });

    // Handle iOS Safari visibility change (wake lock release & watchdog recovery)
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function handleSaveKey() {
    const val = keyInput?.value?.trim() || '';
    if (val.length < 32) {
      alert('Key must be at least 32 characters long.');
      return;
    }
    publisherKey = val;
    localStorage.setItem(STORAGE_KEY, publisherKey);
    keySection?.classList.add('hidden');
    controlsSection?.classList.remove('hidden');
    log('info', 'Publisher key stored in localStorage');
  }

  let forgetConfirm = false;
  function handleForgetKey() {
    if (!forgetConfirm) {
      forgetConfirm = true;
      forgetKeyBtn.textContent = 'Confirm Forget?';
      setTimeout(() => {
        forgetConfirm = false;
        forgetKeyBtn.textContent = 'Forget Key';
      }, 3000);
      return;
    }
    localStorage.removeItem(STORAGE_KEY);
    publisherKey = '';
    forgetKeyBtn.textContent = 'Forget Key';
    forgetConfirm = false;
    window.location.reload();
  }

  // 2. Camera Capture with Resolution Fallback Ladder
  async function acquireMediaStream(facingMode) {
    // Resolution ladder: 720p ideal -> 480p fallback -> standard video fallback
    const attempts = [
      {
        name: '720p @ 15fps',
        constraints: {
          video: {
            facingMode: facingMode ? { ideal: facingMode } : 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 15, max: 30 },
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true,
          },
        },
      },
      {
        name: '480p fallback',
        constraints: {
          video: {
            facingMode: facingMode ? { ideal: facingMode } : 'environment',
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: true,
        },
      },
      {
        name: 'Basic video fallback',
        constraints: { video: true, audio: true },
      },
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        log('info', `Attempting getUserMedia: ${attempt.name}`);
        const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        log('info', `Camera acquired successfully using ${attempt.name}`);
        return stream;
      } catch (err) {
        lastError = err;
        log('warn', `getUserMedia attempt failed (${attempt.name}): ${err.message}`);
      }
    }

    throw lastError || new Error('Could not acquire any camera stream.');
  }

  async function handleStartCamera() {
    startErrorMsg?.classList.add('hidden');
    const selectedFacing = cameraSelect?.value || 'environment';

    try {
      localStream = await acquireMediaStream(selectedFacing);

      // Safari requirement: muted and playsinline must be set on the preview video
      localVideo.srcObject = localStream;
      localVideo.muted = true;
      localVideo.playsInline = true;
      await localVideo.play();

      setupCard?.classList.add('hidden');
      publisherFooter?.classList.remove('hidden');
      screenOffBtn?.classList.remove('hidden');
      statusDot?.classList.add('online');

      // Request Screen Wake Lock (Safari iOS 16.4+ user gesture requirement)
      requestWakeLock();

      // Start signaling connection
      initSignaling();

      // Start watchdog and uptime counter
      startTime = Date.now();
      startWatchdogs();

      // Start 60s auto-screen-off countdown
      resetAutoScreenOffTimer();

      log('info', 'Publisher started and active');
    } catch (err) {
      log('error', `Camera start failed: ${err.message}`);
      if (startErrorMsg) {
        startErrorMsg.textContent = `Camera access error: ${err.name} — ${err.message}. Please reload and allow permissions.`;
        startErrorMsg.classList.remove('hidden');
      }
    }
  }

  // 3. Wake Lock Management
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        log('info', 'Screen Wake Lock active');
        wakeLock.addEventListener('release', () => {
          log('info', 'Screen Wake Lock was released');
        });
      } catch (err) {
        log('warn', `Wake Lock error: ${err.message}`);
        wakeLockWarning?.classList.remove('hidden');
      }
    } else {
      log('warn', 'Wake Lock API not supported in this browser');
      wakeLockWarning?.classList.remove('hidden');
    }
  }

  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      log('info', 'Tab returned to visible. Re-requesting Wake Lock and checking camera health.');
      requestWakeLock();
      checkCameraHealth();
    }
  }

  // 4. Screen-Off Overlay (saves iPad OLED/LCD power and avoids bright screen at night)
  function showScreenOffOverlay() {
    screenOffOverlay?.classList.remove('hidden');
    log('info', 'Screen-off mode active. Tap screen to wake UI.');
  }

  function hideScreenOffOverlay() {
    screenOffOverlay?.classList.add('hidden');
    resetAutoScreenOffTimer();
  }

  function resetAutoScreenOffTimer() {
    if (autoScreenOffTimer) {
      clearTimeout(autoScreenOffTimer);
    }
    // Automatically turn screen black after 60s of inactivity if stream is running
    if (localStream) {
      autoScreenOffTimer = setTimeout(() => {
        showScreenOffOverlay();
      }, 60000);
    }
  }

  // 5. WebRTC Peer Connection Management
  function initSignaling() {
    signaling = new SignalingClient({
      role: 'publisher',
      getKey: () => publisherKey,
      onStateChange: (state) => {
        if (state === 'open') {
          statusDot?.classList.add('online');
          statusDot?.classList.remove('connecting', 'error');
        } else if (state === 'connecting') {
          statusDot?.classList.add('connecting');
          statusDot?.classList.remove('online', 'error');
        } else {
          statusDot?.classList.remove('online', 'connecting');
        }
      },
      onAuthFailed: (reason) => {
        alert(`Publisher Authentication Failed: ${reason}`);
        localStorage.removeItem(STORAGE_KEY);
        window.location.reload();
      },
      onMessage: handleSignalingMessage,
    });

    signaling.connect();
  }

  /**
   * Handle incoming signaling messages from server
   * @param {any} msg
   */
  async function handleSignalingMessage(msg) {
    const type = msg.type;

    if (type === 'viewer_joined') {
      // New viewer joined -> create dedicated RTCPeerConnection and offer
      const viewerId = msg.viewer_id;
      log('info', `Viewer joined [${viewerId}]. Establishing WebRTC connection.`);
      await createPeerConnectionForViewer(viewerId, false);
    } else if (type === 'answer') {
      // Viewer accepted offer with SDP answer
      const viewerId = msg.viewer_id;
      const conn = peerConnections.get(viewerId);
      if (conn && conn.pc) {
        log('info', `Setting remote description (answer) for viewer [${viewerId}]`);
        try {
          await conn.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          // Flush any buffered candidates that arrived before the SDP answer
          if (conn.iceQueue && conn.iceQueue.length > 0) {
            log('info', `Flushing ${conn.iceQueue.length} queued ICE candidate(s) for [${viewerId}]`);
            while (conn.iceQueue.length > 0) {
              const cand = conn.iceQueue.shift();
              try {
                await conn.pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch (err) {}
            }
          }
        } catch (e) {
          log('error', `Failed to set remote answer for [${viewerId}]: ${e.message}`);
        }
      }
    } else if (type === 'ice') {
      // Inbound ICE candidate from viewer
      const viewerId = msg.viewer_id;
      const conn = peerConnections.get(viewerId);
      if (conn && conn.pc && msg.candidate) {
        if (!conn.pc.remoteDescription) {
          if (!conn.iceQueue) conn.iceQueue = [];
          conn.iceQueue.push(msg.candidate);
        } else {
          try {
            await conn.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (e) {
            log('warn', `Failed to add ICE candidate for [${viewerId}]: ${e.message}`);
          }
        }
      }
    } else if (type === 'viewer_restart') {
      // Viewer requested ICE restart
      const viewerId = msg.viewer_id;
      log('info', `Viewer [${viewerId}] requested ICE restart.`);
      await createPeerConnectionForViewer(viewerId, true);
    } else if (type === 'viewer_quality') {
      // Viewer requested quality change
      const viewerId = msg.viewer_id;
      const quality = msg.quality;
      applyEncodingQuality(viewerId, quality);
    } else if (type === 'viewer_left') {
      // Viewer disconnected
      const viewerId = msg.viewer_id;
      log('info', `Viewer [${viewerId}] left. Cleaning up connection.`);
      cleanupPeerConnection(viewerId);
      updateViewerCount();
    }
  }

  /**
   * Create or renegotiate peer connection for specific viewer
   * @param {string} viewerId
   * @param {boolean} isIceRestart
   */
  async function createPeerConnectionForViewer(viewerId, isIceRestart) {
    if (!localStream) {
      log('warn', 'Cannot connect viewer: localStream is null');
      return;
    }

    let conn = peerConnections.get(viewerId);
    let pc;

    if (!conn || !isIceRestart) {
      if (conn && conn.pc) {
        conn.pc.close();
      }

      const rtcConfig = {
        iceServers: iceServersConfig,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      };

      pc = new RTCPeerConnection(rtcConfig);
      conn = { pc, makingOffer: false, quality: 'auto', iceQueue: [] };
      peerConnections.set(viewerId, conn);

      // Add local tracks (sendonly)
      localStream.getTracks().forEach((track) => {
        const transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [localStream],
        });

        // Prefer H.264 hardware encoder on iPad
        if (track.kind === 'video' && 'setCodecPreferences' in transceiver && window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
          try {
            const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
            const h264Codecs = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
            const otherCodecs = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
            if (h264Codecs.length > 0) {
              transceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
              log('info', `Configured H.264 codec preference for viewer [${viewerId}]`);
            }
          } catch (e) {
            log('warn', 'Codec preference error:', e.message);
          }
        }
      });

      // Trickle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && signaling) {
          log('info', `[${viewerId}] Sent local ICE candidate: ${event.candidate.type || 'cand'}`);
          signaling.send({
            type: 'ice',
            viewer_id: viewerId,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        log('info', `Viewer [${viewerId}] WebRTC connection state: ${pc.connectionState}`);
      };

      pc.oniceconnectionstatechange = () => {
        log('info', `Viewer [${viewerId}] ICE state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          // Attempt recovery
          createPeerConnectionForViewer(viewerId, true);
        }
      };

      // Set initial encoding parameters (800 kbps, 15 fps for Auto)
      applyInitialBitrate(pc);
    } else {
      pc = conn.pc;
    }

    // Create and send SDP offer
    try {
      conn.makingOffer = true;
      const offerOptions = isIceRestart ? { iceRestart: true } : {};
      const offer = await pc.createOffer(offerOptions);

      if (pc.signalingState !== 'closed') {
        await pc.setLocalDescription(offer);
        signaling.send({
          type: 'offer',
          viewer_id: viewerId,
          sdp: offer.sdp,
        });
        log('info', `Sent SDP offer (${isIceRestart ? 'ICE restart' : 'initial'}) to viewer [${viewerId}]`);
      }
    } catch (e) {
      log('error', `Failed to create/send offer to [${viewerId}]: ${e.message}`);
    } finally {
      conn.makingOffer = false;
      updateViewerCount();
    }
  }

  async function applyInitialBitrate(pc) {
    const senders = pc.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
    if (videoSender && videoSender.getParameters) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 800000; // 800 kbps
        params.encodings[0].maxFramerate = 15;
        await videoSender.setParameters(params);
        log('info', 'Applied initial Auto encoding (800 kbps, 15 fps)');
      } catch (e) {
        log('warn', 'Could not set initial sender parameters:', e.message);
      }
    }
  }

  async function applyEncodingQuality(viewerId, quality) {
    const conn = peerConnections.get(viewerId);
    if (!conn || !conn.pc) return;

    conn.quality = quality;
    const senders = conn.pc.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
    if (videoSender && videoSender.getParameters) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }

        if (quality === 'high') {
          params.encodings[0].maxBitrate = 2000000; // 2 Mbps
          params.encodings[0].maxFramerate = 30;
          log('info', `Set High quality (2 Mbps, 30 fps) for viewer [${viewerId}]`);
        } else {
          params.encodings[0].maxBitrate = 800000; // 800 kbps
          params.encodings[0].maxFramerate = 15;
          log('info', `Set Auto quality (800 kbps, 15 fps) for viewer [${viewerId}]`);
        }
        await videoSender.setParameters(params);
      } catch (e) {
        log('warn', `Failed setting quality for [${viewerId}]: ${e.message}`);
      }
    }
  }

  function cleanupPeerConnection(viewerId) {
    const conn = peerConnections.get(viewerId);
    if (conn) {
      try {
        conn.pc.close();
      } catch (e) {}
      peerConnections.delete(viewerId);
    }
  }

  function updateViewerCount() {
    if (viewerCountEl) {
      viewerCountEl.textContent = String(peerConnections.size);
    }
  }

  // 6. Publisher Watchdog and Self-Healing Recovery
  function startWatchdogs() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (uptimeTimer) clearInterval(uptimeTimer);

    // Watchdog every 5 seconds: checks track states & encoded frame progress
    watchdogTimer = setInterval(checkCameraHealth, 5000);

    // Uptime counter every 1 second
    uptimeTimer = setInterval(updateUptime, 1000);
  }

  async function checkCameraHealth() {
    if (!localStream || isRecovering) return;

    // Check track readyState
    const tracks = localStream.getTracks();
    const hasDeadTrack = tracks.some((t) => t.readyState === 'ended');

    // Check video encoder progress across active peer connections
    let totalFramesEncoded = 0;
    for (const [_, conn] of peerConnections) {
      const stats = await readVideoStats(conn.pc, 'outbound');
      totalFramesEncoded += stats.frames;
      if (stats.width > 0 && statResolution) {
        statResolution.textContent = `${stats.width}x${stats.height} @ ${stats.fps}fps`;
      }
    }

    if (peerConnections.size > 0) {
      if (totalFramesEncoded === lastFramesEncoded) {
        framesStuckSeconds += 5;
      } else {
        framesStuckSeconds = 0;
        lastFramesEncoded = totalFramesEncoded;
      }
    } else {
      framesStuckSeconds = 0;
    }

    // Trigger recovery if a track ended or frames stuck for >= 15 seconds with active viewers
    if (hasDeadTrack || framesStuckSeconds >= 15) {
      log('warn', `Watchdog detected stall! deadTrack=${hasDeadTrack}, stuckSeconds=${framesStuckSeconds}. Triggering recovery.`);
      await recoverCameraPipeline();
    }
  }

  async function recoverCameraPipeline() {
    if (isRecovering) return;
    isRecovering = true;
    log('info', 'Starting self-healing camera recovery...');

    try {
      // 1. Stop existing tracks
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }

      // 2. Re-acquire camera
      const selectedFacing = cameraSelect?.value || 'environment';
      localStream = await acquireMediaStream(selectedFacing);
      localVideo.srcObject = localStream;
      await localVideo.play();

      const newVideoTrack = localStream.getVideoTracks()[0];
      const newAudioTrack = localStream.getAudioTracks()[0];

      // 3. Hot-replace tracks on all connected viewers
      let replaceFailed = false;
      for (const [viewerId, conn] of peerConnections) {
        try {
          const senders = conn.pc.getSenders();
          for (const sender of senders) {
            if (sender.track && sender.track.kind === 'video' && newVideoTrack) {
              await sender.replaceTrack(newVideoTrack);
            } else if (sender.track && sender.track.kind === 'audio' && newAudioTrack) {
              await sender.replaceTrack(newAudioTrack);
            }
          }
          log('info', `Hot-replaced tracks for viewer [${viewerId}]`);
        } catch (e) {
          log('warn', `replaceTrack failed for viewer [${viewerId}]: ${e.message}`);
          replaceFailed = true;
        }
      }

      // 4. If hot replacement failed, re-offer to all viewers
      if (replaceFailed) {
        log('info', 'Re-offering to all viewers after stream recovery');
        for (const [viewerId] of peerConnections) {
          await createPeerConnectionForViewer(viewerId, true);
        }
      }

      framesStuckSeconds = 0;
      log('info', 'Camera pipeline recovery completed successfully.');
    } catch (e) {
      log('error', `Camera recovery failed: ${e.message}`);
    } finally {
      isRecovering = false;
    }
  }

  function updateUptime() {
    if (!startTime || !statUptime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    statUptime.textContent = `${hrs}:${mins}:${secs}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
