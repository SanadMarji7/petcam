// @ts-check
'use strict';

/**
 * Petcam Viewer Controller (Google Pixel & Mobile / Desktop Chrome optimized)
 * Features:
 * - One-click WebRTC watch stream with zero dependencies
 * - Candidate buffering before setRemoteDescription
 * - Audio unmuting gesture
 * - Resolution & FPS live metrics
 * - Watchdog self-healing on Wi-Fi/mobile network transitions
 */

(function () {
  const { log, SignalingClient, readVideoStats } = window.Petcam;

  // DOM Elements
  const videoWrapper = document.getElementById('video-wrapper');
  const remoteVideo = /** @type {HTMLVideoElement} */ (document.getElementById('remote-video'));
  const keyCard = document.getElementById('key-card');
  const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key-input'));
  const saveKeyBtn = document.getElementById('save-key-btn');
  const forgetKeyBtn = document.getElementById('forget-key-btn');
  const authErrorMsg = document.getElementById('auth-error-msg');
  const offlineBanner = document.getElementById('offline-banner');

  // Controls & Status Strip
  const audioToggleBtn = document.getElementById('audio-toggle-btn');
  const audioIcon = document.getElementById('audio-icon');
  const audioText = document.getElementById('audio-text');
  const qualityToggleBtn = document.getElementById('quality-toggle-btn');
  const qualityModeText = document.getElementById('quality-mode-text');
  const reconnectBtn = document.getElementById('reconnect-btn');

  const statusDot = document.getElementById('status-dot');
  const connStateEl = document.getElementById('conn-state');
  const iceStateEl = document.getElementById('ice-state');
  const feedStatsEl = document.getElementById('feed-stats');

  // State
  const STORAGE_KEY = 'petcam_viewer_key';
  let viewerKey = localStorage.getItem(STORAGE_KEY) || '';
  /** @type {SignalingClient | null} */
  let signaling = null;
  /** @type {RTCPeerConnection | null} */
  let pc = null;
  /** @type {RTCIceCandidateInit[]} */
  let iceCandidatesQueue = [];
  let isPublisherOnline = false;
  let currentQuality = 'auto'; // 'auto' | 'high'
  let iceServersConfig = [];

  // Watchdog state
  let watchdogTimer = null;
  let lastFramesDecoded = 0;
  let stuckFramesSeconds = 0;
  let consecutiveFailures = 0;
  let isGracePeriodActive = false;
  let graceTimeout = null;
  let backoffCountdownTimer = null;

  // 1. Initialization and Auth
  function init() {
    if (viewerKey) {
      keyCard?.classList.add('hidden');
    } else {
      keyCard?.classList.remove('hidden');
    }

    saveKeyBtn?.addEventListener('click', handleSaveKey);
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    audioToggleBtn?.addEventListener('click', toggleAudio);
    qualityToggleBtn?.addEventListener('click', toggleQuality);
    reconnectBtn?.addEventListener('click', () => manualReconnect('User requested reconnect'));

    // Video fullscreen on single tap; ignore double-tap
    initFullscreenTap();

    // Re-check on network online or tab visibility change
    window.addEventListener('online', () => {
      log('info', 'Network came back ONLINE. Triggering immediate reconnect.');
      manualReconnect('Network back online');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        log('info', 'Tab became visible. Checking stream health.');
        if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
          manualReconnect('Visibility changed to visible');
        }
      }
    });

    // Fetch STUN fallback config if enabled
    fetch('/config.json')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.ice_servers) {
          iceServersConfig = data.ice_servers;
        }
      })
      .catch(() => {});

    if (viewerKey) {
      connectSignaling();
    }
  }

  function handleSaveKey() {
    const val = keyInput?.value?.trim() || '';
    if (val.length < 32) {
      if (authErrorMsg) {
        authErrorMsg.textContent = 'Viewer key must be at least 32 characters long.';
        authErrorMsg.classList.remove('hidden');
      }
      return;
    }
    viewerKey = val;
    localStorage.setItem(STORAGE_KEY, viewerKey);
    keyCard?.classList.add('hidden');
    connectSignaling();
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
    viewerKey = '';
    forgetKeyBtn.textContent = 'Forget Key';
    forgetConfirm = false;
    window.location.reload();
  }

  // 2. Video Fullscreen & Audio Gestures
  let lastTapTime = 0;
  function initFullscreenTap() {
    remoteVideo?.addEventListener('click', (e) => {
      const now = Date.now();
      // Ignore if double-tap (within 300ms)
      if (now - lastTapTime < 300) {
        lastTapTime = now;
        return;
      }
      lastTapTime = now;

      // Toggle fullscreen on container
      if (!document.fullscreenElement) {
        if (videoWrapper?.requestFullscreen) {
          videoWrapper.requestFullscreen().catch(() => {});
        } else if (remoteVideo.webkitEnterFullscreen) {
          // iOS Safari fallback
          remoteVideo.webkitEnterFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    });
  }

  function toggleAudio() {
    if (remoteVideo.muted) {
      remoteVideo.muted = false;
      remoteVideo.play().catch(() => {});
      if (audioIcon) audioIcon.textContent = '🔊';
      if (audioText) audioText.textContent = 'Mute';
      audioToggleBtn?.setAttribute('aria-label', 'Audio Playing. Click to Mute');
      log('info', 'Audio unmuted by user gesture');
    } else {
      remoteVideo.muted = true;
      if (audioIcon) audioIcon.textContent = '🔇';
      if (audioText) audioText.textContent = 'Unmute';
      audioToggleBtn?.setAttribute('aria-label', 'Audio Muted. Click to Unmute');
      log('info', 'Audio muted');
    }
  }

  function toggleQuality() {
    currentQuality = currentQuality === 'auto' ? 'high' : 'auto';
    if (qualityModeText) {
      qualityModeText.textContent = currentQuality === 'high' ? 'High (2M)' : 'Auto (800k)';
    }
    if (signaling && isPublisherOnline) {
      signaling.send({ type: 'quality', quality: currentQuality });
      log('info', `Requested quality change to: ${currentQuality}`);
    }
  }

  // 3. Signaling and WebRTC Connection
  function connectSignaling() {
    updateStateUI('Connecting...', 'connecting');

    signaling = new SignalingClient({
      role: 'viewer',
      getKey: () => viewerKey,
      onStateChange: (state) => {
        if (state === 'error' || state === 'closed') {
          updateStateUI('Disconnected', 'connecting');
        }
      },
      onAuthOk: () => {
        log('info', 'Viewer authenticated. Sending join request...');
        signaling.send({ type: 'join' });
      },
      onAuthFailed: (reason) => {
        updateStateUI(`Auth Error: ${reason}`, 'error');
        if (authErrorMsg) {
          authErrorMsg.textContent = `Authentication failed: ${reason}`;
          authErrorMsg.classList.remove('hidden');
        }
        keyCard?.classList.remove('hidden');
      },
      onMessage: handleSignalingMessage,
    });

    signaling.connect();
    startWatchdog();
  }

  async function handleSignalingMessage(msg) {
    const type = msg.type;

    if (type === 'publisher_online') {
      isPublisherOnline = true;
      offlineBanner?.classList.add('hidden');
      updateStateUI('Camera Online. Connecting...', 'connecting');
      log('info', 'Publisher is online.');
    } else if (type === 'publisher_offline') {
      isPublisherOnline = false;
      offlineBanner?.classList.remove('hidden');
      updateStateUI('Camera offline', 'connecting');
      cleanupPeerConnection();
      log('info', 'Publisher is offline.');
    } else if (type === 'publisher_changed') {
      log('info', 'Publisher changed on server. Resetting connection...');
      cleanupPeerConnection();
      if (signaling) {
        signaling.send({ type: 'join' });
      }
    } else if (type === 'offer') {
      log('info', 'Received SDP offer from publisher');
      await handleOffer(msg.sdp);
    } else if (type === 'ice') {
      if (msg.candidate) {
        handleRemoteIceCandidate(msg.candidate);
      }
    } else if (type === 'error' && msg.reason === 'too_many_viewers') {
      updateStateUI('Viewer limit reached', 'error');
      alert('Too many viewers connected (server maximum reached). Please try again later.');
    }
  }

  async function handleOffer(sdp) {
    try {
      if (pc) {
        cleanupPeerConnection();
      }

      iceCandidatesQueue = [];

      const rtcConfig = {
        iceServers: iceServersConfig,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      };

      pc = new RTCPeerConnection(rtcConfig);

      // On incoming media track, attach to video element
      pc.ontrack = (event) => {
        log('info', `Received remote track kind=${event.track.kind}`);
        if (remoteVideo.srcObject !== event.streams[0]) {
          remoteVideo.srcObject = event.streams[0];
          remoteVideo.play().catch((err) => {
            log('warn', `Autoplay prevented: ${err.message}. Tap to play.`);
          });
        }
      };

      // Trickle ICE to server
      pc.onicecandidate = (event) => {
        if (event.candidate && signaling) {
          signaling.send({
            type: 'ice',
            candidate: event.candidate,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const iceState = pc ? pc.iceConnectionState : 'closed';
        if (iceStateEl) iceStateEl.textContent = iceState;
        log('info', `ICE connection state changed to: ${iceState}`);

        if (iceState === 'connected' || iceState === 'completed') {
          updateStateUI('Live', 'online');
          consecutiveFailures = 0;
          stuckFramesSeconds = 0;
        } else if (iceState === 'disconnected') {
          // Grace period of 5 seconds before attempting restart
          handleGracePeriod();
        } else if (iceState === 'failed') {
          log('warn', 'ICE failed! Triggering watchdog restart.');
          triggerWatchdogRestart();
        }
      };

      // Set remote SDP offer
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

      // Flush any queued ICE candidates that arrived before remoteDescription was set
      while (iceCandidatesQueue.length > 0) {
        const candidate = iceCandidatesQueue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          log('warn', `Failed adding queued candidate: ${e.message}`);
        }
      }

      // Create and send SDP answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (signaling) {
        signaling.send({
          type: 'answer',
          sdp: answer.sdp,
        });
        log('info', 'Sent SDP answer back to publisher');
      }

      // If user had toggled High quality before connecting, request it now
      if (currentQuality === 'high' && signaling) {
        signaling.send({ type: 'quality', quality: 'high' });
      }
    } catch (err) {
      log('error', `Failed to handle offer: ${err.message}`);
      updateStateUI(`Error: ${err.message}`, 'error');
    }
  }

  async function handleRemoteIceCandidate(candidate) {
    if (!pc || !pc.remoteDescription) {
      // Buffer until setRemoteDescription finishes
      iceCandidatesQueue.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      log('warn', `Failed to add remote candidate: ${e.message}`);
    }
  }

  function handleGracePeriod() {
    if (isGracePeriodActive) return;
    isGracePeriodActive = true;
    log('info', 'ICE disconnected. Starting 5s grace period before recovery.');

    if (graceTimeout) clearTimeout(graceTimeout);
    graceTimeout = setTimeout(() => {
      isGracePeriodActive = false;
      if (pc && pc.iceConnectionState === 'disconnected') {
        log('warn', 'Grace period ended and still disconnected. Triggering restart.');
        triggerWatchdogRestart();
      }
    }, 5000);
  }

  // 4. Watchdog & Self-Healing Logic
  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);

    // Watchdog polls getStats every 2 seconds
    watchdogTimer = setInterval(async () => {
      if (!pc || !isPublisherOnline) return;

      const stats = await readVideoStats(pc, 'inbound');

      // Update resolution and fps
      if (feedStatsEl && (stats.width > 0 || stats.fps > 0)) {
        feedStatsEl.textContent = `${stats.width}x${stats.height} @ ${stats.fps}fps`;
      }

      const isLive = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      if (!isLive) return;

      // Check if framesDecoded is progressing
      if (stats.frames === lastFramesDecoded) {
        stuckFramesSeconds += 2;
      } else {
        stuckFramesSeconds = 0;
        lastFramesDecoded = stats.frames;
        consecutiveFailures = 0;
      }

      // Watchdog rule: stuck for 8s -> send restart (ICE restart)
      if (stuckFramesSeconds === 8) {
        log('warn', 'Watchdog: Video frames stuck for 8s. Requesting ICE restart from publisher.');
        if (signaling) {
          signaling.send({ type: 'restart' });
        }
      }

      // Watchdog rule: still stuck 10s later (total 18s) -> close connection and send join
      if (stuckFramesSeconds >= 18) {
        log('warn', 'Watchdog: Video frames still stuck after ICE restart. Rebuilding connection.');
        triggerWatchdogRestart();
      }
    }, 2000);
  }

  function triggerWatchdogRestart() {
    consecutiveFailures++;
    stuckFramesSeconds = 0;

    if (consecutiveFailures >= 3) {
      log('warn', 'Watchdog: 3 consecutive failures. Backing off for 30s before retrying.');
      startBackoffCountdown(30);
      return;
    }

    manualReconnect('Watchdog automatic recovery');
  }

  function startBackoffCountdown(seconds) {
    cleanupPeerConnection();
    let remaining = seconds;

    if (backoffCountdownTimer) clearInterval(backoffCountdownTimer);

    updateStateUI(`Reconnecting (${remaining}s)...`, 'connecting');
    backoffCountdownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(backoffCountdownTimer);
        backoffCountdownTimer = null;
        consecutiveFailures = 0;
        manualReconnect('Backoff period expired');
      } else {
        updateStateUI(`Reconnecting (${remaining}s)...`, 'connecting');
      }
    }, 1000);
  }

  function manualReconnect(reason) {
    log('info', `Reconnecting stream. Reason: ${reason}`);
    if (backoffCountdownTimer) {
      clearInterval(backoffCountdownTimer);
      backoffCountdownTimer = null;
    }
    cleanupPeerConnection();
    updateStateUI('Reconnecting...', 'connecting');

    if (signaling && signaling.isAuthenticated) {
      signaling.send({ type: 'join' });
    } else if (signaling) {
      signaling.connect();
    }
  }

  function cleanupPeerConnection() {
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      pc = null;
    }
    if (remoteVideo) {
      remoteVideo.srcObject = null;
    }
    if (iceStateEl) iceStateEl.textContent = 'closed';
    if (feedStatsEl) feedStatsEl.textContent = '0x0 @ 0fps';
  }

  function updateStateUI(text, statusType) {
    if (connStateEl) connStateEl.textContent = text;

    statusDot?.classList.remove('online', 'connecting', 'error');
    if (statusType === 'online') {
      statusDot?.classList.add('online');
    } else if (statusType === 'connecting') {
      statusDot?.classList.add('connecting');
    } else if (statusType === 'error') {
      statusDot?.classList.add('error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
