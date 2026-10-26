// @ts-check
'use strict';

/**
 * Petcam viewer page (/watch) for a phone or laptop, built on LiveKit.
 *
 * Flow: pairing key -> POST /api/token -> Room.connect -> the camera's tracks
 * arrive through RoomEvent.TrackSubscribed. The picture is attached to the
 * <video> element, the sound to a hidden <audio> element created here.
 *
 * LiveKit handles ICE, simulcast and short network blips by itself. This file
 * owns the UI, the pairing key, push-to-talk and the recovery LiveKit does
 * not do on its own: a fresh token after a full disconnect (tokens expire
 * after an hour), a stalled decoder, a server restart, the page waking up.
 *
 * Browser facts that shape this file:
 *  - Chrome and Safari only autoplay muted media. The <video> stays muted for
 *    ever; sound comes from a separate <audio> element that the Unmute tap
 *    unmutes (a tap is a user gesture, which is what the browsers require).
 *  - LiveKit's track.attach() flips `muted` to false on any element that gets
 *    an audio track. Chrome pauses a muted-autoplay video that is unmuted
 *    without a gesture, so audio never goes to the <video> element.
 *  - iOS Safari needs room.startAudio() inside a tap to unlock audio output.
 *  - A long press on a phone opens the copy menu or starts a scroll; the talk
 *    button cancels both so "hold to talk" works.
 */
(function () {
  const P = window.Petcam;
  const log = P.log;
  const LK = P.LK;

  const KEY_STORAGE = 'petcam_viewer_key';
  const DEVICE_STORAGE = 'petcam_device_id';
  const CAMERA_PREFIX = 'cam-'; // identity prefix the control plane gives the camera
  const WATCHDOG_INTERVAL_MS = 2000;
  const STALL_SECONDS = 10; // decoded-frame counter flat this long while Live -> rebuild
  const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
  const VIEWER_LIMIT_RETRY_SECONDS = 20;
  const FAILURES_BEFORE_NOTICE = 3;
  const NOTICE_AUTO_HIDE_MS = 8000;
  const MIC_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

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
  const noticeBanner = $('notice-banner');
  const audioToggleBtn = $('audio-toggle-btn');
  const audioIcon = $('audio-icon');
  const audioText = $('audio-text');
  const talkBtn = /** @type {HTMLButtonElement | null} */ ($('talk-btn'));
  const talkText = $('talk-text');
  const qualityModeText = $('quality-mode-text');
  const statusDot = $('status-dot');
  const connStateEl = $('conn-state');
  const linkStateEl = $('ice-state'); // label reads "Link": room connection state / quality
  const feedStatsEl = $('feed-stats');

  // State
  let viewerKey = P.takeKeyFromFragment(KEY_STORAGE) || P.readStoredKey(KEY_STORAGE);
  const deviceId = P.getDeviceId(DEVICE_STORAGE);

  /** @type {any} */
  let room = null; // the current LiveKit Room, null between connections
  let connectGeneration = 0; // bumped on every connect/teardown; stale callbacks compare against it
  let connecting = false;
  let halted = false; // true after an error that retrying will not fix (wrong key, opened elsewhere)
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let quality = 'auto'; // 'auto' | 'high'
  let cameraOnline = false;

  /** @type {any} */
  let videoTrack = null;
  /** @type {any} */
  let videoPublication = null;
  /** @type {Set<any>} */
  const audioTracks = new Set();
  /** @type {HTMLAudioElement} */
  let audioEl;
  let audioEnabled = false; // the user tapped Unmute

  let talkWanted = false; // the button (or Space) is held down
  let talking = false; // the microphone is really on
  let talkChain = Promise.resolve();

  let watchdogTimer = null;
  let checking = false;
  let lastFramesDecoded = -1;
  let stallSeconds = 0;
  let linkQuality = '';
  let noticeTimer = null;

  // ------------------------------------------------------------------ init

  function init() {
    keyCard?.classList.toggle('hidden', !!viewerKey);

    $('save-key-btn')?.addEventListener('click', handleSaveKey);
    keyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveKey();
    });
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    audioToggleBtn?.addEventListener('click', toggleAudio);
    $('quality-toggle-btn')?.addEventListener('click', toggleQuality);
    $('reconnect-btn')?.addEventListener('click', () => {
      halted = false;
      reconnectAttempt = 0;
      hideNotice();
      reconnect('Reconnect button');
    });
    initShareQr();
    initFullscreenTap();
    initTalk();
    createAudioElement();

    playOverlay?.addEventListener('click', () => {
      // Runs inside a tap, so the browser lets us (re)start playback.
      playOverlay.classList.add('hidden');
      tryPlayVideo();
      if (audioEnabled) startSound();
    });
    remoteVideo?.addEventListener('playing', () => {
      playOverlay?.classList.add('hidden');
      refreshState();
    });

    window.addEventListener('online', () => onWake('network is back'));
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) onWake('page restored from cache');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onWake('page visible again');
      else setTalk(false); // never leave the microphone open while the page is hidden
    });

    if (!LK) {
      // common.js already logged the missing bundle.
      setState('Error: video library did not load', 'error');
      showNotice('The video player failed to load. Reload the page; if it keeps happening, check the server logs.', true);
      halted = true;
      return;
    }
    forwardLiveKitLogs();
    startWatchdog();
    if (viewerKey) connect('page load');
    else setState('Enter the viewer key', 'connecting');
  }

  /** LiveKit's own warnings and errors go into the on-page diagnostic log. */
  function forwardLiveKitLogs() {
    try {
      LK.setLogLevel('warn');
      LK.setLogExtension((level, msg) => {
        const errorLevel = LK.LogLevel && typeof LK.LogLevel.error === 'number' ? LK.LogLevel.error : 4;
        log(level >= errorLevel ? 'error' : 'warn', `LiveKit: ${msg}`);
      });
    } catch (err) {
      log('warn', `Could not hook LiveKit logging: ${err.message}`);
    }
  }

  function createAudioElement() {
    audioEl = document.createElement('audio');
    audioEl.id = 'remote-audio';
    audioEl.autoplay = true;
    audioEl.muted = true; // muted autoplay is allowed everywhere; Unmute lifts it inside a tap
    audioEl.setAttribute('playsinline', '');
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }

  function handleSaveKey() {
    const value = (keyInput?.value || '').trim();
    if (value.length < 32) {
      showAuthError('The key must be at least 32 characters. Scan the phone QR code again or ask the server owner for the viewer key.');
      return;
    }
    viewerKey = value;
    P.storeKey(KEY_STORAGE, value);
    authError?.classList.add('hidden');
    keyCard?.classList.add('hidden');
    halted = false;
    reconnectAttempt = 0;
    hideNotice();
    reconnect('new key');
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

  /** Small banner above the controls for things the person can act on. */
  function showNotice(text, sticky) {
    if (!noticeBanner) return;
    noticeBanner.textContent = text;
    noticeBanner.classList.remove('hidden');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = sticky ? null : setTimeout(hideNotice, NOTICE_AUTO_HIDE_MS);
  }

  function hideNotice() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeBanner?.classList.add('hidden');
  }

  // -------------------------------------------------------------- controls

  function toggleAudio() {
    audioEnabled = !audioEnabled;
    updateAudioButton();
    if (audioEnabled) {
      log('info', 'Sound on');
      startSound(); // inside the tap: this is the gesture Safari and Chrome want
    } else {
      audioEl.muted = true;
      log('info', 'Sound off');
    }
  }

  /**
   * Unmute the hidden audio element and let LiveKit unlock audio output.
   * Call this from a tap handler whenever possible.
   */
  function startSound() {
    audioEl.muted = false;
    const r = room;
    const attempt = r ? r.startAudio() : audioEl.play();
    // room.startAudio() resumes LiveKit's AudioContext (iOS plays nothing without it) and
    // calls play() on every element a remote audio track is attached to, ours included.
    Promise.resolve(attempt)
      .then(() => playOverlay?.classList.add('hidden'))
      .catch((err) => {
        log('warn', `Could not start sound: ${err && err.message}`);
        showNotice('The browser blocked the sound. Tap Unmute again.');
        audioEnabled = false;
        audioEl.muted = true;
        updateAudioButton();
      });
  }

  function updateAudioButton() {
    if (audioIcon) audioIcon.textContent = audioEnabled ? '🔊' : '🔇';
    if (audioText) audioText.textContent = audioEnabled ? 'Mute' : 'Unmute';
    audioToggleBtn?.setAttribute('aria-label', audioEnabled ? 'Mute audio' : 'Unmute audio');
  }

  /** Keep the audio element's muted flag in step with the Unmute button after (re)attaching a track. */
  function applyAudioState() {
    audioEl.muted = !audioEnabled;
    if (audioTracks.size === 0) return;
    const p = audioEl.play();
    if (p) {
      p.catch((err) => {
        if (audioEnabled && err && err.name === 'NotAllowedError') {
          // Chrome: the page was never tapped in this session (e.g. reopened from the home screen).
          log('warn', 'Sound needs a tap to resume');
          playOverlay?.classList.remove('hidden');
        }
      });
    }
  }

  /**
   * Restart the hidden audio element if the browser paused it while sound is on. iOS pauses
   * it for an incoming call, Siri, or the audio-session change when push-to-talk opens the
   * microphone, and nothing (no event, no LiveKit callback) announces that. Safe to call often.
   */
  function resumeAudioIfPaused() {
    if (!audioEnabled || !audioEl.paused || audioTracks.size === 0) return;
    const p = audioEl.play();
    if (!p) return;
    p.then(() => log('info', 'Sound resumed')).catch((err) => {
      if (err && err.name === 'NotAllowedError') playOverlay?.classList.remove('hidden');
    });
  }

  /**
   * Quality toggle.
   *
   * "Auto": the Room runs with adaptiveStream, so LiveKit asks the server for the
   * simulcast layer that fits the <video> element on screen (times pixel density)
   * and pauses the stream while the element is hidden. We still call
   * setVideoQuality(HIGH) so the ceiling is the full layer; adaptive stream decides below it.
   *
   * "High": always the full-resolution layer, whatever the element size. With
   * adaptiveStream on, LiveKit's track update always uses the adaptive dimensions as the
   * cap (setVideoQuality can only lower it), and adaptiveStream is fixed when the Room is
   * created. So "High" means a Room without adaptive stream, and toggling reconnects.
   * That takes about a second on an SFU and the toggle is rare, so this is acceptable.
   */
  function toggleQuality() {
    quality = quality === 'auto' ? 'high' : 'auto';
    if (qualityModeText) qualityModeText.textContent = quality === 'high' ? 'High' : 'Auto';
    log('info', `Quality set to ${quality}`);
    if (room || connecting) reconnect('quality changed');
  }

  function applyQuality() {
    if (!videoPublication || typeof videoPublication.setVideoQuality !== 'function') return;
    try {
      videoPublication.setVideoQuality(LK.VideoQuality.HIGH);
    } catch (err) {
      log('warn', `Could not set video quality: ${err.message}`);
    }
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
        else if (remoteVideo.webkitEnterFullscreen) remoteVideo.webkitEnterFullscreen(); // iOS Safari has no Fullscreen API
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

  // ---------------------------------------------------------- push-to-talk

  function initTalk() {
    if (!talkBtn) return;
    const start = (e) => {
      if (e.type === 'pointerdown' && e.button !== 0) return; // left button / primary touch only
      // preventDefault: no text selection on desktop, no long-press copy menu or scroll on phones.
      // Pointer and touch events both fire on phones; setTalk() is idempotent so that is harmless.
      if (e.cancelable) e.preventDefault();
      setTalk(true);
    };
    const stop = () => setTalk(false);
    talkBtn.addEventListener('pointerdown', start);
    talkBtn.addEventListener('pointerup', stop);
    talkBtn.addEventListener('pointercancel', stop);
    talkBtn.addEventListener('pointerleave', stop);
    talkBtn.addEventListener('touchstart', start, { passive: false });
    talkBtn.addEventListener('touchend', stop);
    talkBtn.addEventListener('touchcancel', stop);
    talkBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // Android long press
    window.addEventListener('blur', stop);

    // Keyboard: hold Space anywhere except in a text field.
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      setTalk(true);
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      setTalk(false);
    });
    updateTalkButton();
  }

  function isTypingTarget(target) {
    const el = /** @type {HTMLElement | null} */ (target);
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  /** Called on every press/release; the real microphone work is serialised in talkChain. */
  function setTalk(wanted) {
    if (wanted === talkWanted) return;
    talkWanted = wanted;
    const r = room;
    if (wanted && (!r || r.state !== LK.ConnectionState.Connected)) {
      talkWanted = false;
      showNotice('Not connected yet. Wait for the state to say Live, then hold the button.');
      updateTalkButton();
      return;
    }
    updateTalkButton();
    // Enabling the mic runs getUserMedia, which can take a while (first time: a permission
    // prompt). The finger may lift meanwhile, so each step applies the latest wish instead of
    // the one it was queued with, and steps never overlap.
    talkChain = talkChain
      .then(async () => {
        if (room !== r) return;
        const target = talkWanted;
        if (target === talking) return;
        await r.localParticipant.setMicrophoneEnabled(target, MIC_CAPTURE);
        talking = target;
        log('info', talking ? 'Microphone on (talking)' : 'Microphone off');
        if (talking && !talkWanted) {
          // Released during the permission prompt: switch it off again right away.
          await r.localParticipant.setMicrophoneEnabled(false);
          talking = false;
          log('info', 'Microphone off');
        }
        // Opening or closing the microphone changes the audio session on iOS, which can pause
        // the camera's sound; this still runs inside the press, so play() is allowed.
        resumeAudioIfPaused();
      })
      .catch((err) => {
        talking = false;
        talkWanted = false;
        log('error', `Microphone failed: ${err && err.name}: ${err && err.message}`);
        showNotice(friendlyMicError(err));
      })
      .then(updateTalkButton);
  }

  function updateTalkButton() {
    if (!talkBtn) return;
    const connected = !!room && room.state === LK.ConnectionState.Connected;
    talkBtn.disabled = !connected;
    const active = talkWanted || talking;
    talkBtn.classList.toggle('active', active);
    talkBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (talkText) talkText.textContent = talking ? 'Talking…' : talkWanted ? 'Starting mic…' : 'Hold to talk';
  }

  function friendlyMicError(err) {
    const name = (err && err.name) || '';
    const message = (err && err.message) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError' || /permission/i.test(message)) {
      return 'Microphone permission was denied. Allow the microphone for this site in the browser settings, then try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using the microphone. Close it and try again.';
    if (/not allowed|insufficient|publish/i.test(message)) return 'The server does not allow this viewer to talk. Check the viewer key.';
    return `Microphone error: ${name ? name + ': ' : ''}${message || String(err)}`;
  }

  // ---------------------------------------------------------------- room

  /**
   * Ask for a token and join the room. Safe to call repeatedly; overlapping calls are ignored.
   *
   * `connecting` belongs to the newest attempt (the one whose `gen` equals connectGeneration).
   * An attempt that was superseded while it waited must leave the flag alone: clearing it
   * would let the watchdog start a third attempt next to the current one.
   */
  async function connect(reason) {
    if (!viewerKey || connecting || halted) return;
    cancelReconnectTimer();
    connecting = true;
    const gen = ++connectGeneration;
    setState('Connecting', 'connecting');
    log('info', `Connecting (${reason})`);
    P.storeKey(KEY_STORAGE, viewerKey); // keep the stored copy fresh (see common.js on Safari's storage limit)

    let grant;
    try {
      grant = await P.requestToken('viewer', viewerKey, deviceId);
    } catch (err) {
      if (gen !== connectGeneration) return;
      connecting = false;
      handleTokenError(err);
      return;
    }
    if (gen !== connectGeneration) return;

    const r = new LK.Room({
      adaptiveStream: quality === 'auto', // see toggleQuality()
      dynacast: true,
      publishDefaults: {
        // Release the microphone between talks: the red "recording" indicator goes away and
        // the next hold re-acquires it (no new permission prompt once granted).
        stopMicTrackOnMute: true,
      },
    });
    bindRoomEvents(r, gen);
    room = r;
    updateLink();
    try {
      await r.connect(grant.url, grant.token, { autoSubscribe: true });
    } catch (err) {
      if (gen !== connectGeneration) return;
      connecting = false;
      room = null;
      updateLink();
      log('error', `Could not join the room: ${err && err.message}`);
      setState('Reconnecting', 'connecting');
      if (reconnectAttempt + 1 >= FAILURES_BEFORE_NOTICE) showNotice(friendlyConnectError(err), true);
      scheduleReconnect('join failed');
      return;
    }
    if (gen !== connectGeneration) {
      // Something newer replaced this attempt while we were joining.
      r.disconnect().catch(() => {});
      return;
    }
    connecting = false;
    reconnectAttempt = 0;
    hideNotice();
    log('info', `Joined room ${grant.room} as ${grant.identity} (${grant.url})`);
    updateLink();
    refreshCameraPresence(); // tracks already in the room arrive via TrackSubscribed right after this
    updateTalkButton();
  }

  function bindRoomEvents(r, gen) {
    const E = LK.RoomEvent;
    const alive = () => gen === connectGeneration && room === r;

    r.on(E.ConnectionStateChanged, (state) => {
      if (!alive()) return;
      log('info', `Room ${state}`);
      updateLink();
      updateTalkButton();
      refreshState();
    });
    r.on(E.Reconnecting, () => alive() && setState('Reconnecting', 'connecting'));
    r.on(E.SignalReconnecting, () => alive() && setState('Reconnecting', 'connecting'));
    r.on(E.Reconnected, () => {
      if (!alive()) return;
      log('info', 'Reconnected to the room');
      stallSeconds = 0;
      refreshCameraPresence();
    });
    r.on(E.Disconnected, (reason) => {
      if (!alive()) return;
      handleDisconnected(reason);
    });
    r.on(E.ParticipantConnected, (participant) => {
      if (!alive()) return;
      log('info', `${participant.identity} joined`);
      refreshCameraPresence();
    });
    r.on(E.ParticipantDisconnected, (participant) => {
      if (!alive()) return;
      log('info', `${participant.identity} left`);
      refreshCameraPresence();
    });
    r.on(E.TrackSubscribed, (track, publication, participant) => {
      if (!alive()) return;
      handleTrackSubscribed(track, publication, participant);
    });
    r.on(E.TrackUnsubscribed, (track, publication, participant) => {
      if (!alive()) return;
      handleTrackUnsubscribed(track, participant);
    });
    r.on(E.TrackSubscriptionFailed, (sid, participant, reason) => {
      if (!alive()) return;
      log('warn', `Could not subscribe to a track from ${participant.identity}`, reason);
    });
    r.on(E.TrackMuted, (publication, participant) => {
      if (!alive() || participant.isLocal) return;
      log('info', `${participant.identity} paused its ${publication.kind}`);
    });
    r.on(E.TrackUnmuted, (publication, participant) => {
      if (!alive() || participant.isLocal) return;
      log('info', `${participant.identity} resumed its ${publication.kind}`);
      stallSeconds = 0;
    });
    r.on(E.TrackStreamStateChanged, (publication, streamState, participant) => {
      if (!alive() || participant.isLocal) return;
      log('info', `${publication.kind} stream from ${participant.identity} is ${streamState}`);
      stallSeconds = 0;
    });
    r.on(E.ConnectionQualityChanged, (q, participant) => {
      if (!alive() || !participant.isLocal) return;
      linkQuality = q;
      updateLink();
    });
    r.on(E.AudioPlaybackStatusChanged, (canPlay) => {
      if (!alive()) return;
      log('info', `Audio playback ${canPlay ? 'allowed' : 'blocked by the browser'}`);
      if (!canPlay && audioEnabled) playOverlay?.classList.remove('hidden');
    });
    r.on(E.VideoPlaybackStatusChanged, (canPlay) => {
      if (!alive()) return;
      log('info', `Video playback ${canPlay ? 'allowed' : 'blocked by the browser'}`);
      playOverlay?.classList.toggle('hidden', canPlay);
    });
    r.on(E.MediaDevicesError, (err) => {
      if (!alive()) return;
      log('error', `Media device error: ${err && err.name}: ${err && err.message}`);
      showNotice(friendlyMicError(err));
    });
    r.on(E.LocalTrackPublished, (publication) => alive() && log('info', `Published local ${publication.kind}`));
    r.on(E.LocalTrackUnpublished, (publication) => alive() && log('info', `Unpublished local ${publication.kind}`));
  }

  function handleDisconnected(reason) {
    const name = disconnectReasonName(reason);
    log('warn', `Disconnected from the room (${name})`);
    room = null;
    talking = false;
    talkWanted = false;
    detachAllTracks();
    cameraOnline = false;
    offlineBanner?.classList.add('hidden');
    updateLink();
    updateTalkButton();

    const DR = LK.DisconnectReason || {};
    if (reason === DR.DUPLICATE_IDENTITY) {
      // LiveKit lets the newest join with our identity win, so another tab on this device took
      // over. Reconnecting here would just bounce the stream between the two tabs.
      halted = true;
      setState('Opened in another tab', 'error');
      showNotice('This page was opened in another tab or window, which took over the stream. Close it, or tap Reconnect to watch here.', true);
      return;
    }
    setState('Reconnecting', 'connecting');
    scheduleReconnect(name);
  }

  function disconnectReasonName(reason) {
    const DR = LK.DisconnectReason;
    if (DR && typeof reason === 'number' && typeof DR[reason] === 'string') return DR[reason];
    return reason === undefined ? 'no reason given' : String(reason);
  }

  function handleTokenError(err) {
    const code = err && err.code;
    const message = (err && err.message) || 'Unknown error';
    log('error', `Token request failed (${code || 'unknown'}): ${message}`, err && err.detail);
    if (code === 'wrong_key') {
      halted = true;
      viewerKey = '';
      P.storeKey(KEY_STORAGE, '');
      setState('Wrong key', 'error');
      showAuthError(message);
      keyCard?.classList.remove('hidden');
      return;
    }
    if (code === 'too_many_viewers') {
      setState('Viewer limit reached', 'error');
      showNotice(`${message} This page tries again every ${VIEWER_LIMIT_RETRY_SECONDS} seconds.`, true);
      scheduleReconnect('viewer limit', VIEWER_LIMIT_RETRY_SECONDS);
      return;
    }
    if (code === 'bad_request') {
      halted = true;
      setState('Error: server rejected the request', 'error');
      showNotice(message, true);
      return;
    }
    // Network or server trouble: keep trying.
    setState('Reconnecting', 'connecting');
    if (reconnectAttempt + 1 >= FAILURES_BEFORE_NOTICE) showNotice(message, true);
    scheduleReconnect(`token: ${code || 'error'}`);
  }

  function friendlyConnectError(err) {
    const message = (err && err.message) || '';
    // ConnectionError carries a numeric `reason` (LK.ConnectionErrorReason) and a `reasonName`.
    const reasonName = (err && err.reasonName) || '';
    if (reasonName === 'NotAllowed' || /401|403|not allowed|invalid token/i.test(message)) {
      return 'The video server refused this connection. The LiveKit keys on the Petcam server may not match the video server.';
    }
    if (reasonName === 'Timeout' || /timeout|timed out/i.test(message)) {
      return 'The video server did not answer in time. Check the internet connection on this device; this page keeps trying.';
    }
    return 'Cannot reach the video server. Check the internet connection on this device and that the server is running; this page keeps trying.';
  }

  function scheduleReconnect(reason, fixedDelaySeconds) {
    cancelReconnectTimer();
    if (!viewerKey || halted) return;
    const delay = fixedDelaySeconds || BACKOFF_SECONDS[Math.min(reconnectAttempt, BACKOFF_SECONDS.length - 1)];
    if (!fixedDelaySeconds) reconnectAttempt += 1;
    log('info', `Reconnecting in ${delay}s (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnect('automatic retry');
    }, delay * 1000);
  }

  function cancelReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /** Drop the current room (if any) and join again with a fresh token. */
  async function reconnect(reason) {
    await teardownRoom();
    await connect(reason);
  }

  /** Leave the room on purpose. Bumping the generation makes its late events (incl. Disconnected) ignored. */
  async function teardownRoom() {
    cancelReconnectTimer();
    connectGeneration += 1;
    connecting = false;
    const r = room;
    room = null;
    talking = false;
    talkWanted = false;
    detachAllTracks();
    cameraOnline = false;
    offlineBanner?.classList.add('hidden');
    updateLink();
    updateTalkButton();
    if (!r) return;
    try {
      await r.disconnect(); // also stops the local microphone track
    } catch (err) {
      log('warn', `Leaving the room failed: ${err && err.message}`);
    }
  }

  // --------------------------------------------------------------- tracks

  function isCamera(participant) {
    return !!participant && typeof participant.identity === 'string' && participant.identity.startsWith(CAMERA_PREFIX);
  }

  function handleTrackSubscribed(track, publication, participant) {
    if (!isCamera(participant)) {
      // Other viewers' microphones: the camera plays those, we do not. Save the bandwidth.
      log('info', `Ignoring ${track.kind} track from ${participant.identity}`);
      try {
        publication.setSubscribed(false);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    log('info', `Camera ${track.kind} track subscribed`);
    if (track.kind === LK.Track.Kind.Video) {
      if (videoTrack && videoTrack !== track) detachVideo();
      videoTrack = track;
      videoPublication = publication;
      stallSeconds = 0;
      lastFramesDecoded = -1;
      track.attach(remoteVideo);
      remoteVideo.muted = true; // the picture element never carries sound
      applyQuality();
      tryPlayVideo();
    } else if (track.kind === LK.Track.Kind.Audio) {
      audioTracks.add(track);
      // attach() sets autoplay and flips `muted` to false, then tries play(). Without a tap
      // that play() is refused (harmless, logged by LiveKit); applyAudioState() restores
      // the muted flag the Unmute button wants and plays muted, which is always allowed.
      track.attach(audioEl);
      applyAudioState();
    }
    refreshState();
  }

  function handleTrackUnsubscribed(track, participant) {
    if (!isCamera(participant)) return;
    log('info', `Camera ${track.kind} track unsubscribed`);
    if (track === videoTrack) detachVideo();
    if (audioTracks.has(track)) {
      try {
        track.detach(audioEl);
      } catch (_) {
        /* ignore */
      }
      audioTracks.delete(track);
    }
    refreshState();
  }

  function detachVideo() {
    if (videoTrack) {
      try {
        videoTrack.detach(remoteVideo);
      } catch (_) {
        /* ignore */
      }
    }
    videoTrack = null;
    videoPublication = null;
    if (feedStatsEl) feedStatsEl.textContent = '–';
  }

  function detachAllTracks() {
    detachVideo();
    audioTracks.forEach((track) => {
      try {
        track.detach(audioEl);
      } catch (_) {
        /* ignore */
      }
    });
    audioTracks.clear();
  }

  function tryPlayVideo() {
    const p = remoteVideo.play();
    if (!p) return;
    p.then(() => playOverlay?.classList.add('hidden')).catch((err) => {
      if (err && err.name === 'AbortError') return; // a newer play()/load() interrupted it
      log('warn', `Video playback blocked: ${err && err.message}`);
      playOverlay?.classList.remove('hidden');
    });
  }

  /** The camera is "online" when a participant whose identity starts with cam- is in the room. */
  function refreshCameraPresence() {
    const r = room;
    let camera = null;
    if (r && r.remoteParticipants) {
      r.remoteParticipants.forEach((p) => {
        if (!camera && isCamera(p)) camera = p;
      });
    }
    const was = cameraOnline;
    cameraOnline = !!camera;
    const connected = !!r && r.state === LK.ConnectionState.Connected;
    offlineBanner?.classList.toggle('hidden', cameraOnline || !connected);
    if (was !== cameraOnline) log('info', cameraOnline ? `Camera online (${camera.identity})` : 'Camera offline');
    if (!cameraOnline && (videoTrack || audioTracks.size)) detachAllTracks();
    refreshState();
  }

  // -------------------------------------------------------------- status

  function refreshState() {
    if (halted) return;
    const r = room;
    if (!r) {
      if (!connecting && !reconnectTimer && viewerKey) setState('Reconnecting', 'connecting');
      return;
    }
    const S = LK.ConnectionState;
    if (r.state === S.Reconnecting || r.state === S.SignalReconnecting) {
      setState('Reconnecting', 'connecting');
    } else if (r.state !== S.Connected) {
      setState('Connecting', 'connecting');
    } else if (!cameraOnline) {
      setState('Camera offline', 'connecting');
    } else if (videoTrack && !remoteVideo.paused && remoteVideo.readyState >= 2) {
      setState('Live', 'online');
    } else if (videoTrack) {
      setState('Camera online, starting video', 'connecting');
    } else {
      setState('Camera online, waiting for video', 'connecting');
    }
  }

  function setState(text, kind) {
    if (connStateEl) {
      connStateEl.textContent = text;
      connStateEl.className = 'val ' + (kind === 'online' ? 'val-online' : kind === 'error' ? 'val-error' : 'val-connecting');
    }
    statusDot?.classList.remove('online', 'connecting', 'error');
    statusDot?.classList.add(kind);
  }

  /** "Link" column: the room's connection state, or its quality once connected. */
  function updateLink() {
    if (!linkStateEl) return;
    const r = room;
    if (!r) {
      linkStateEl.textContent = 'closed';
      return;
    }
    const state = r.state || 'unknown';
    if (state === LK.ConnectionState.Connected && linkQuality && linkQuality !== LK.ConnectionQuality.Unknown) {
      linkStateEl.textContent = linkQuality; // good / poor / lost
    } else {
      linkStateEl.textContent = state;
    }
  }

  // -------------------------------------------------------------- watchdog

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
  }

  async function checkHealth() {
    if (checking) return;
    checking = true;
    try {
      await checkHealthInner();
    } catch (err) {
      log('warn', `Watchdog error: ${err && err.message}`);
    } finally {
      checking = false;
    }
  }

  async function checkHealthInner() {
    if (!viewerKey || halted) return;
    const r = room;
    if (!r) {
      // Safety net: nothing connected and nothing scheduled (should not happen, but a
      // missed event must never leave the page dead).
      if (!connecting && !reconnectTimer) {
        log('warn', 'Watchdog: no room and no retry pending; connecting');
        connect('watchdog');
      }
      return;
    }
    if (!videoTrack) {
      if (feedStatsEl) feedStatsEl.textContent = '–';
      return;
    }

    const stats = await readVideoStats();
    if (feedStatsEl) feedStatsEl.textContent = stats.width || stats.fps ? `${stats.width}x${stats.height} @ ${stats.fps}fps` : '–';

    // Frames legitimately stop while the page is hidden (adaptive stream pauses the layer),
    // while the camera has muted its video, or while LiveKit itself is reconnecting; none
    // of that is a stall.
    const paused = videoTrack.streamState === LK.Track.StreamState.Paused || !!(videoPublication && videoPublication.isMuted);
    if (document.visibilityState === 'hidden' || paused || r.state !== LK.ConnectionState.Connected || !cameraOnline) {
      stallSeconds = 0;
      lastFramesDecoded = stats.frames;
      return;
    }
    if (remoteVideo.paused && remoteVideo.srcObject) tryPlayVideo();
    resumeAudioIfPaused();

    if (stats.frames >= 0 && stats.frames === lastFramesDecoded) stallSeconds += WATCHDOG_INTERVAL_MS / 1000;
    else stallSeconds = 0;
    lastFramesDecoded = stats.frames;

    if (stallSeconds >= STALL_SECONDS) {
      log('warn', `No new video frames for ${stallSeconds}s; rebuilding the connection`);
      stallSeconds = 0;
      setState('Video stalled, recovering', 'connecting');
      reconnect('video stalled');
    }
  }

  /**
   * Resolution, frame rate and decoded-frame count of the camera's video track.
   * Sources in order: WebRTC inbound-rtp stats (via LiveKit's getRTCStatsReport),
   * the MediaStreamTrack settings, and the <video> element itself.
   */
  async function readVideoStats() {
    const track = videoTrack;
    const out = { width: 0, height: 0, fps: 0, frames: -1 };
    if (!track) return out;
    try {
      const settings = track.mediaStreamTrack && track.mediaStreamTrack.getSettings ? track.mediaStreamTrack.getSettings() : {};
      out.width = settings.width || 0;
      out.height = settings.height || 0;
      out.fps = settings.frameRate ? Math.round(settings.frameRate) : 0;
    } catch (_) {
      /* some browsers throw for remote tracks */
    }
    try {
      const report = typeof track.getRTCStatsReport === 'function' ? await track.getRTCStatsReport() : null;
      if (report) {
        report.forEach((s) => {
          if (s.type !== 'inbound-rtp' || (s.kind || s.mediaType) !== 'video') return;
          if (s.frameWidth) out.width = s.frameWidth;
          if (s.frameHeight) out.height = s.frameHeight;
          if (typeof s.framesPerSecond === 'number') out.fps = Math.round(s.framesPerSecond);
          if (typeof s.framesDecoded === 'number') out.frames = s.framesDecoded;
        });
      }
    } catch (_) {
      /* stats are best effort */
    }
    if (out.frames < 0 && typeof remoteVideo.getVideoPlaybackQuality === 'function') {
      try {
        out.frames = remoteVideo.getVideoPlaybackQuality().totalVideoFrames;
      } catch (_) {
        /* ignore */
      }
    }
    if (!out.width && remoteVideo.videoWidth) {
      out.width = remoteVideo.videoWidth;
      out.height = remoteVideo.videoHeight;
    }
    return out;
  }

  /** online / visibilitychange / pageshow: reconnect if needed, otherwise nudge playback. */
  function onWake(reason) {
    if (!viewerKey || halted) return;
    const r = room;
    if (!r) {
      if (!connecting) {
        log('info', `${reason}: reconnecting now`);
        reconnectAttempt = 0;
        reconnect(reason);
      }
      return;
    }
    if (remoteVideo.paused && remoteVideo.srcObject) tryPlayVideo();
    resumeAudioIfPaused();
    refreshState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
