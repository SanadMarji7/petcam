// @ts-check
'use strict';

/**
 * Petcam camera page (/cam), normally an iPad in Safari.
 *
 * Flow: Start camera → get local audio/video tracks with the LiveKit client →
 * ask the Petcam server for a LiveKit token → join the room → publish both
 * tracks. LiveKit's SFU fans the stream out to every viewer, so there is no
 * per-viewer connection on this page any more.
 *
 * What this page still has to do by itself:
 *  - keep the camera alive (watchdog + re-acquire, wake lock, screen-off overlay)
 *  - get a fresh token and rejoin when the room connection is lost for good
 *  - play the viewers' microphones (talk-back)
 */
(function () {
  const P = window.Petcam;
  const log = P.log;
  const LK = P.LK;

  const KEY_STORAGE = 'petcam_publisher_key';
  const DEVICE_STORAGE = 'petcam_publisher_device_id';
  const AUTO_SCREEN_OFF_MS = 60000;
  const WATCHDOG_INTERVAL_MS = 5000;
  const MUTED_STALL_MS = 15000; // OS-muted video track for this long while visible => re-acquire
  const DISCONNECTED_GRACE_MS = 20000; // room silently Disconnected this long => force our own reconnect
  const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
  const VIDEO_ENCODING = { maxBitrate: 1_500_000, maxFramerate: 30 };
  const AUDIO_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  // DOM
  const $ = (id) => document.getElementById(id);
  const localVideo = /** @type {HTMLVideoElement} */ ($('local-video'));
  const setupCard = $('setup-card');
  const keySection = $('key-section');
  const keyInput = /** @type {HTMLInputElement} */ ($('key-input'));
  const keyError = $('key-error-msg');
  const controlsSection = $('controls-section');
  const cameraSelect = /** @type {HTMLSelectElement} */ ($('camera-select'));
  const startBtn = /** @type {HTMLButtonElement} */ ($('start-cam-btn'));
  const startError = $('start-error-msg');
  const wakeLockWarning = $('wake-lock-warning');
  const screenOffBtn = $('screen-off-btn');
  const screenOffOverlay = $('screen-off-overlay');
  const forgetKeyBtn = $('forget-key-btn');
  const statusDot = $('status-dot');
  const footer = $('publisher-footer');
  const streamStatus = $('stream-status');
  const viewerCountEl = $('viewer-count');
  const statResolution = $('stat-resolution');
  const statUptime = $('stat-uptime');

  // State
  let publisherKey = P.takeKeyFromFragment(KEY_STORAGE) || P.readStoredKey(KEY_STORAGE);
  const deviceId = P.getDeviceId(DEVICE_STORAGE);
  /** @type {any} LiveKit Room (one instance, reused across reconnects) */
  let room = null;
  /** @type {any} LiveKit LocalVideoTrack */
  let videoTrack = null;
  /** @type {any} LiveKit LocalAudioTrack (null when the device has no microphone) */
  let audioTrack = null;
  /** Hidden container for the <audio> elements that play the viewers' microphones. */
  let talkbackContainer = null;

  let wakeLock = null;
  let watchdogTimer = null;
  let uptimeTimer = null;
  let autoScreenOffTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnecting = false;
  let startTime = 0;
  let mutedSince = 0;
  let disconnectedSince = 0;
  let recovering = false;
  let running = false; // true between Start camera and stopEverything()

  // ------------------------------------------------------------------ init

  function init() {
    if (!LK) {
      showBanner(startError, 'The video library did not load. Reload the page; if it keeps failing, check the server logs.');
      showBanner(keyError, 'The video library did not load. Reload the page; if it keeps failing, check the server logs.');
    } else {
      // LiveKit's own debug output is very chatty; keep warnings and errors and copy them
      // into the on-page diagnostic log so field problems can be read off the iPad.
      if (typeof LK.setLogLevel === 'function') LK.setLogLevel('warn');
      if (typeof LK.setLogExtension === 'function') {
        LK.setLogExtension((level, msg, context) => {
          const warn = LK.LogLevel ? LK.LogLevel.warn : 3;
          if (level < warn) return;
          log(level >= warn + 1 ? 'error' : 'warn', `LiveKit: ${msg}`, context && context.error ? String(context.error) : undefined);
        });
      }
    }

    showKeyUI(!publisherKey);

    $('save-key-btn')?.addEventListener('click', handleSaveKey);
    keyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveKey();
    });
    forgetKeyBtn?.addEventListener('click', handleForgetKey);
    startBtn?.addEventListener('click', startCamera);
    screenOffBtn?.addEventListener('click', showScreenOff);
    screenOffOverlay?.addEventListener('click', hideScreenOff);

    document.addEventListener('touchstart', resetAutoScreenOff, { passive: true });
    document.addEventListener('mousemove', resetAutoScreenOff);
    // Any tap counts as the user gesture Safari wants before it lets us play talk-back audio.
    document.addEventListener('touchend', unlockAudioPlayback, { passive: true });
    document.addEventListener('click', unlockAudioPlayback);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', () => {
      log('info', 'Browser reports the network is back');
      if (running) reconnectNow();
    });
  }

  function showKeyUI(show) {
    keySection?.classList.toggle('hidden', !show);
    controlsSection?.classList.toggle('hidden', show);
  }

  function handleSaveKey() {
    const value = (keyInput?.value || '').trim();
    if (value.length < 32) {
      showBanner(keyError, 'The key must be at least 32 characters. Scan the iPad QR code again or ask the server owner for the camera key.');
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

  /**
   * Get camera + microphone as LiveKit local tracks.
   * 720p first, then 480p, then whatever the device offers, then video only
   * (a device without a microphone can still be a camera).
   * @returns {Promise<{video: any, audio: any}>}
   */
  async function acquireTracks(facingMode) {
    const facing = facingMode || 'environment';
    // 480p is spelled out: LiveKit's 16:9 VideoPresets table has no h480 entry (only the 4:3 table does).
    const ladder = [
      { name: '720p', options: { audio: AUDIO_CAPTURE, video: { facingMode: facing, resolution: LK.VideoPresets.h720.resolution } } },
      { name: '480p', options: { audio: AUDIO_CAPTURE, video: { facingMode: facing, resolution: { width: 640, height: 480, frameRate: 30 } } } },
      { name: 'default', options: { audio: true, video: true } },
      { name: 'video only', options: { audio: false, video: true } },
    ];
    let lastError = null;
    for (const attempt of ladder) {
      try {
        const tracks = await LK.createLocalTracks(attempt.options);
        const video = tracks.find((t) => t.kind === LK.Track.Kind.Video) || null;
        const audio = tracks.find((t) => t.kind === LK.Track.Kind.Audio) || null;
        if (!video) {
          // Should not happen, but never leave a dangling microphone running.
          tracks.forEach((t) => t.stop());
          throw new Error('The browser returned no video track');
        }
        const settings = video.mediaStreamTrack.getSettings ? video.mediaStreamTrack.getSettings() : {};
        log('info', `Camera acquired (${attempt.name}): ${settings.width}x${settings.height} @ ${settings.frameRate || '?'} fps${audio ? '' : ', no microphone'}`);
        if (!audio) log('warn', 'No microphone: viewers will see video without sound');
        return { video, audio };
      } catch (err) {
        lastError = err;
        log('warn', `createLocalTracks ${attempt.name} failed: ${err && err.name}: ${err && err.message}`);
        // Permission denied will not change on the next rung; stop asking.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
      }
    }
    throw lastError || new Error('No camera available');
  }

  async function startCamera() {
    if (!LK) return;
    startError?.classList.add('hidden');
    startBtn.disabled = true;
    try {
      const tracks = await acquireTracks(cameraSelect?.value || 'environment');
      videoTrack = tracks.video;
      audioTrack = tracks.audio;
      watchTrackEnded(videoTrack);
      if (audioTrack) watchTrackEnded(audioTrack);
      attachPreview();

      running = true;
      setupCard?.classList.add('hidden');
      footer?.classList.remove('hidden');
      screenOffBtn?.classList.remove('hidden');
      setStreamStatus('Connecting', 'connecting');

      await requestWakeLock(); // inside the tap handler: Safari needs a user gesture

      startTime = Date.now();
      startWatchdog();
      resetAutoScreenOff();

      try {
        await connectRoom();
      } catch (err) {
        if (err && err.code === 'wrong_key') {
          handleWrongKey(err);
          return;
        }
        // The camera is running; keep trying to reach the server in the background.
        log('error', `Could not join the room: ${err && err.message}`);
        setStreamStatus('Reconnecting', 'connecting');
        scheduleReconnect();
      }
    } catch (err) {
      running = false;
      startBtn.disabled = false;
      log('error', `Start failed: ${err && err.message}`);
      setStreamStatus('Camera error', 'error');
      showBanner(startError, P.friendlyMediaError(err));
    }
  }

  /** Show our own track in the preview. attach() puts the MediaStreamTrack into the element's srcObject. */
  function attachPreview() {
    if (!videoTrack) return;
    videoTrack.attach(localVideo);
    localVideo.muted = true; // never play our own microphone back to the room
    localVideo.play().catch(() => {});
  }

  function watchTrackEnded(track) {
    // iOS ends the capture track when the system takes the camera (phone call, Control Center, lock).
    // LiveKit re-emits the MediaStreamTrack's "ended" as TrackEvent.Ended, also after replaceTrack().
    track.on(LK.TrackEvent.Ended, () => {
      log('warn', `${track.kind} track ended by the system`);
      recoverCamera(`${track.kind} track ended`);
    });
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
      log('warn', `Wake lock failed: ${err && err.message}`);
      wakeLockWarning?.classList.remove('hidden');
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible' || !running) return;
    // Safari releases the wake lock and may have frozen the camera while hidden.
    log('info', 'Page visible again: renewing wake lock and checking the camera');
    requestWakeLock();
    checkHealth();
    if (room && room.state === LK.ConnectionState.Disconnected) reconnectNow();
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
    if (running) autoScreenOffTimer = setTimeout(showScreenOff, AUTO_SCREEN_OFF_MS);
  }

  // ------------------------------------------------------------------ room

  function ensureRoom() {
    if (room) return room;
    room = new LK.Room({
      adaptiveStream: false, // we publish, we do not watch
      dynacast: true, // stop encoding simulcast layers nobody is subscribed to
      // Keep our camera/mic alive when the room drops: we republish the same tracks after reconnecting.
      stopLocalTrackOnUnpublish: false,
      publishDefaults: {
        videoCodec: 'h264', // iPad hardware encoder; viewers pick a layer via simulcast
        simulcast: true,
        videoSimulcastLayers: [LK.VideoPresets.h180, LK.VideoPresets.h360],
      },
    });

    const E = LK.RoomEvent;
    room
      .on(E.Connected, () => {
        log('info', `Joined room "${room.name}" as ${room.localParticipant.identity}`);
        disconnectedSince = 0;
        setStreamStatus('Streaming', 'online');
        updateViewerCount();
      })
      .on(E.Reconnecting, () => {
        log('warn', 'Connection to LiveKit interrupted; LiveKit is reconnecting');
        setStreamStatus('Reconnecting', 'connecting');
      })
      .on(E.SignalReconnecting, () => {
        log('info', 'Signaling link interrupted; LiveKit is resuming it');
      })
      .on(E.Reconnected, () => {
        log('info', 'LiveKit reconnected');
        disconnectedSince = 0;
        setStreamStatus('Streaming', 'online');
        updateViewerCount();
      })
      .on(E.Disconnected, onRoomDisconnected)
      .on(E.ParticipantConnected, (participant) => {
        if (isViewer(participant)) log('info', `Viewer [${participant.identity}] joined`);
        else log('info', `Participant [${participant.identity}] joined`);
        updateViewerCount();
      })
      .on(E.ParticipantDisconnected, (participant) => {
        if (isViewer(participant)) log('info', `Viewer [${participant.identity}] left`);
        else log('info', `Participant [${participant.identity}] left`);
        updateViewerCount();
      })
      .on(E.TrackSubscribed, onTrackSubscribed)
      .on(E.TrackUnsubscribed, onTrackUnsubscribed)
      .on(E.LocalTrackPublished, (pub) => {
        log('info', `Published ${pub.source} track${pub.source === LK.Track.Source.Camera ? ' (h264, simulcast)' : ''}`);
      })
      .on(E.LocalTrackUnpublished, (pub) => {
        log('info', `Unpublished ${pub.source} track`);
      })
      .on(E.AudioPlaybackStatusChanged, () => {
        if (room.canPlaybackAudio) log('info', 'Talk-back audio playback allowed');
        else log('warn', 'The browser is blocking talk-back audio until the screen is tapped');
      })
      .on(E.MediaDevicesError, (err) => {
        log('error', `Media device error: ${err && err.name}: ${err && err.message}`);
      })
      .on(E.ConnectionQualityChanged, (quality, participant) => {
        if (participant && participant.isLocal && quality !== LK.ConnectionQuality.Excellent) {
          log('warn', `Upload connection quality: ${quality}`);
        }
      });
    return room;
  }

  function isViewer(participant) {
    return !!participant && typeof participant.identity === 'string' && participant.identity.startsWith('viewer-');
  }

  /** Token → connect → publish. Throws (with .code on token errors) so the caller decides what to do. */
  async function connectRoom() {
    const r = ensureRoom();
    // Tokens live one hour, so every (re)connect fetches a fresh one.
    const info = await P.requestToken('camera', publisherKey, deviceId);
    P.storeKey(KEY_STORAGE, publisherKey); // keep the stored copy fresh (see common.js on Safari's storage limit)
    log('info', `Connecting to ${info.url} (room ${info.room})`);
    await r.connect(info.url, info.token);
    await publishTracks();
    // Safari only plays audio that was unlocked by a user gesture; the Start tap is ours.
    try {
      await r.startAudio();
    } catch (err) {
      log('warn', `Audio playback not unlocked yet: ${err && err.message}`);
    }
    setStreamStatus('Streaming', 'online');
    updateViewerCount();
  }

  async function publishTracks() {
    if (!room) return;
    const lp = room.localParticipant;
    if (videoTrack) {
      const existing = lp.getTrackPublication(LK.Track.Source.Camera);
      if (!existing || existing.track !== videoTrack) {
        await lp.publishTrack(videoTrack, { source: LK.Track.Source.Camera, videoEncoding: VIDEO_ENCODING });
      }
    }
    if (audioTrack) {
      const existing = lp.getTrackPublication(LK.Track.Source.Microphone);
      if (!existing || existing.track !== audioTrack) {
        await lp.publishTrack(audioTrack, { source: LK.Track.Source.Microphone });
      }
    }
  }

  function onRoomDisconnected(reason) {
    const R = LK.DisconnectReason || {};
    const name = reasonName(reason);
    if (!running) return; // we stopped on purpose
    if (reason === R.CLIENT_INITIATED) {
      log('info', 'Left the room');
      return;
    }
    if (reason === R.DUPLICATE_IDENTITY) {
      handleReplaced();
      return;
    }
    log('warn', `Disconnected from the room (${name}); will rejoin with a fresh token`);
    disconnectedSince = Date.now();
    setStreamStatus('Reconnecting', 'connecting');
    updateViewerCount();
    scheduleReconnect();
  }

  function reasonName(reason) {
    const R = LK.DisconnectReason || {};
    for (const key of Object.keys(R)) {
      if (R[key] === reason && isNaN(Number(key))) return key;
    }
    return String(reason);
  }

  // ------------------------------------------------------------ reconnect

  function scheduleReconnect() {
    if (!running || reconnectTimer || reconnecting) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    log('info', `Rejoining in ${delay / 1000} s (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectNow();
    }, delay);
  }

  async function reconnectNow() {
    if (!running || reconnecting || !videoTrack) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const r = ensureRoom();
    if (r.state === LK.ConnectionState.Connected) {
      // LiveKit got there first; just make sure our tracks are published.
      reconnectAttempt = 0;
      try {
        await publishTracks();
      } catch (err) {
        log('warn', `Republish failed: ${err && err.message}`);
      }
      return;
    }
    if (r.state === LK.ConnectionState.Connecting || r.state === LK.ConnectionState.Reconnecting || r.state === LK.ConnectionState.SignalReconnecting) {
      return; // LiveKit is already on it; the Disconnected/Reconnected events will tell us how it went
    }
    reconnecting = true;
    setStreamStatus('Reconnecting', 'connecting');
    try {
      await connectRoom();
      reconnectAttempt = 0;
      log('info', 'Rejoined the room');
    } catch (err) {
      if (err && err.code === 'wrong_key') {
        reconnecting = false;
        handleWrongKey(err);
        return;
      }
      log('warn', `Rejoin failed: ${err && err.message}`);
      reconnecting = false;
      scheduleReconnect();
      return;
    }
    reconnecting = false;
  }

  function handleWrongKey(err) {
    log('error', 'The server rejected the camera key');
    P.storeKey(KEY_STORAGE, '');
    publisherKey = '';
    stopEverything();
    setStreamStatus('Wrong key', 'error');
    setupCard?.classList.remove('hidden');
    showKeyUI(true);
    showBanner(keyError, (err && err.message) || 'The server rejected this key. Scan the iPad QR code again or paste the publisher key.');
  }

  /**
   * Another /cam page in the same browser joined with our identity, so LiveKit
   * dropped us. Do not fight back automatically (the two pages would kick each
   * other forever); let the person choose which page streams.
   */
  function handleReplaced() {
    log('warn', 'Another camera page on this device took over the stream');
    stopEverything();
    setStreamStatus('Taken over', 'error');
    setupCard?.classList.remove('hidden');
    showKeyUI(false);
    showBanner(startError, 'Another camera page on this device took over. Close it, then tap Start camera to stream from here again.');
  }

  // -------------------------------------------------------------- talk-back

  function onTrackSubscribed(track, publication, participant) {
    if (track.kind !== LK.Track.Kind.Audio) return; // viewers only ever send audio
    if (!talkbackContainer) {
      talkbackContainer = document.createElement('div');
      talkbackContainer.id = 'talkback-audio';
      talkbackContainer.setAttribute('aria-hidden', 'true');
      talkbackContainer.style.display = 'none';
      document.body.appendChild(talkbackContainer);
    }
    // One <audio> per viewer so two people talking at once both come through.
    const el = track.attach();
    el.autoplay = true;
    talkbackContainer.appendChild(el);
    log('info', `Talk-back audio from viewer [${participant.identity}] is on`);
    unlockAudioPlayback();
  }

  function onTrackUnsubscribed(track, publication, participant) {
    if (track.kind !== LK.Track.Kind.Audio) return;
    track.detach().forEach((el) => el.remove());
    log('info', `Talk-back audio from viewer [${participant.identity}] is off`);
  }

  /** The talk-back <audio> elements that are not playing right now. */
  function pausedTalkbackElements() {
    if (!talkbackContainer) return [];
    return Array.from(talkbackContainer.querySelectorAll('audio')).filter((el) => el.paused);
  }

  /**
   * Called on every tap: Safari/Chrome block audio playback until a gesture resumes it.
   * Also resumes talk-back elements the OS paused later (a phone call, Siri, an audio-session
   * change): LiveKit does not notice those, so room.canPlaybackAudio stays true and only the
   * paused elements themselves tell us something is wrong.
   */
  function unlockAudioPlayback() {
    if (!room) return;
    const paused = pausedTalkbackElements();
    if (!paused.length && room.canPlaybackAudio) return;
    room
      .startAudio()
      .then(() => {
        if (paused.length) log('info', `Talk-back audio resumed (${paused.length} paused element${paused.length === 1 ? '' : 's'})`);
      })
      .catch((err) => log('warn', `Could not unlock audio playback: ${err && err.message}`));
  }

  /**
   * Watchdog version of the above, without a user gesture: a plain play() on each paused
   * element. It succeeds after an OS interruption and is refused (quietly) while the browser
   * still waits for a tap; the next tap goes through unlockAudioPlayback().
   */
  function resumePausedTalkback() {
    const paused = pausedTalkbackElements();
    if (!paused.length || !room || room.state !== LK.ConnectionState.Connected) return;
    paused.forEach((el) => {
      const p = el.play();
      if (!p) return;
      p.then(() => log('info', 'Talk-back audio resumed by the watchdog')).catch((err) => {
        if (!err || err.name !== 'NotAllowedError') log('warn', `Talk-back audio could not resume: ${err && err.message}`);
      });
    });
  }

  function clearTalkback() {
    if (talkbackContainer) talkbackContainer.innerHTML = '';
  }

  // -------------------------------------------------------------- watchdog

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (uptimeTimer) clearInterval(uptimeTimer);
    watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
    uptimeTimer = setInterval(updateUptime, 1000);
  }

  async function checkHealth() {
    if (!running || !videoTrack || recovering) return;
    if (document.visibilityState === 'hidden') return; // Safari froze us; wait until visible

    const mst = videoTrack.mediaStreamTrack;
    const audioMst = audioTrack ? audioTrack.mediaStreamTrack : null;
    const trackEnded = (mst && mst.readyState === 'ended') || (audioMst && audioMst.readyState === 'ended');

    // mediaStreamTrack.muted is the OS saying "no frames right now" (not the LiveKit mute).
    // Safari does this when the camera is taken away without ending the track.
    if (mst && mst.muted) {
      if (!mutedSince) mutedSince = Date.now();
    } else {
      mutedSince = 0;
    }
    const mutedTooLong = mutedSince && Date.now() - mutedSince >= MUTED_STALL_MS;

    await updateResolution();
    updateViewerCount();
    resumePausedTalkback();

    // Safety net: LiveKit normally emits Disconnected and we rejoin, but if the room sits
    // in Disconnected with nothing scheduled, kick a reconnect ourselves.
    if (room && room.state === LK.ConnectionState.Disconnected && !reconnectTimer && !reconnecting) {
      if (!disconnectedSince) disconnectedSince = Date.now();
      if (Date.now() - disconnectedSince >= DISCONNECTED_GRACE_MS) {
        log('warn', 'Room has been disconnected for a while with no reconnect in flight; rejoining');
        reconnectNow();
      }
    }

    if (trackEnded || mutedTooLong) {
      await recoverCamera(trackEnded ? 'a track ended' : `no frames from the camera for ${Math.round((Date.now() - mutedSince) / 1000)} s`);
    }
  }

  async function updateResolution() {
    if (!statResolution || !videoTrack) return;
    let width = 0;
    let height = 0;
    let fps = 0;
    try {
      // Per simulcast layer; the biggest one is what the encoder is really producing.
      const stats = typeof videoTrack.getSenderStats === 'function' ? await videoTrack.getSenderStats() : null;
      if (Array.isArray(stats)) {
        for (const s of stats) {
          if (s && s.frameWidth && s.frameWidth > width) {
            width = s.frameWidth;
            height = s.frameHeight || 0;
            fps = Math.round(s.framesPerSecond || 0);
          }
        }
      }
    } catch (_) {
      /* not published yet, or stats unsupported: fall back to the capture settings */
    }
    if (!width) {
      const settings = videoTrack.mediaStreamTrack && videoTrack.mediaStreamTrack.getSettings ? videoTrack.mediaStreamTrack.getSettings() : {};
      width = settings.width || 0;
      height = settings.height || 0;
      fps = Math.round(settings.frameRate || 0);
    }
    if (!width) {
      statResolution.textContent = '–';
      return;
    }
    statResolution.textContent = fps ? `${width}x${height} @ ${fps}fps` : `${width}x${height}`;
  }

  /**
   * Re-acquire the camera and swap the new MediaStreamTrack into the published
   * LiveKit track (replaceTrack), so viewers keep their subscription and simply
   * see new frames. If the track is not published right now, swap the whole
   * LiveKit track and let the next (re)connect publish it.
   */
  async function recoverCamera(reason) {
    if (recovering || !running || !videoTrack) return;
    if (document.visibilityState === 'hidden') return;
    recovering = true;
    log('warn', `Recovering camera: ${reason}`);
    setStreamStatus('Recovering', 'connecting');
    let fresh = null;
    try {
      fresh = await acquireTracks(cameraSelect?.value || 'environment');
      await swapTrack('video', fresh.video);
      if (fresh.audio) {
        await swapTrack('audio', fresh.audio);
      } else if (audioTrack) {
        log('warn', 'Microphone not available after recovery; continuing with video only');
      }
      attachPreview();
      mutedSince = 0;
      if (room && room.state === LK.ConnectionState.Connected) {
        await publishTracks();
        setStreamStatus('Streaming', 'online');
      } else {
        setStreamStatus('Reconnecting', 'connecting');
      }
      log('info', 'Camera recovered');
    } catch (err) {
      log('error', `Camera recovery failed: ${err && err.message}`);
      setStreamStatus('Camera error', 'error');
      // Do not leave a half-adopted camera or microphone running (the recording light would stay on).
      if (fresh) [fresh.video, fresh.audio].forEach(discardIfUnused);
    } finally {
      recovering = false;
    }
  }

  /** Stop a freshly acquired LocalTrack unless its MediaStreamTrack is now in use. */
  function discardIfUnused(track) {
    if (!track) return;
    const inUse = [videoTrack, audioTrack].some((t) => t && (t === track || t.mediaStreamTrack === track.mediaStreamTrack));
    if (inUse) return;
    try {
      track.stop();
    } catch (_) {
      /* ignore */
    }
  }

  /** @param {'video' | 'audio'} kind  @param {any} freshTrack a LocalTrack from createLocalTracks */
  async function swapTrack(kind, freshTrack) {
    const current = kind === 'video' ? videoTrack : audioTrack;
    const source = kind === 'video' ? LK.Track.Source.Camera : LK.Track.Source.Microphone;
    const pub = room ? room.localParticipant.getTrackPublication(source) : null;
    const published = !!(pub && current && pub.track === current);

    if (published) {
      // userProvidedTrack:false hands ownership to LiveKit so it stops the old track and restarts the
      // new one on mute/unmute. The LocalTrack wrapper from createLocalTracks is discarded, not stopped.
      await current.replaceTrack(freshTrack.mediaStreamTrack, { userProvidedTrack: false });
      log('info', `${kind} track replaced in place`);
      return;
    }
    if (current) {
      try {
        current.stop();
      } catch (_) {
        /* already ended */
      }
    }
    watchTrackEnded(freshTrack);
    if (kind === 'video') videoTrack = freshTrack;
    else audioTrack = freshTrack;
    log('info', `${kind} track swapped (not published yet)`);
  }

  // ------------------------------------------------------------------ stop

  function stopEverything() {
    running = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (uptimeTimer) clearInterval(uptimeTimer);
    if (autoScreenOffTimer) clearTimeout(autoScreenOffTimer);
    reconnectTimer = watchdogTimer = uptimeTimer = autoScreenOffTimer = null;
    reconnectAttempt = 0;
    reconnecting = false;
    disconnectedSince = 0;
    mutedSince = 0;

    clearTalkback();
    if (room) {
      const r = room;
      room = null;
      r.disconnect().catch(() => {});
    }
    for (const t of [videoTrack, audioTrack]) {
      if (!t) continue;
      try {
        t.detach();
        t.stop();
      } catch (_) {
        /* ignore */
      }
    }
    videoTrack = audioTrack = null;
    localVideo.srcObject = null;
    screenOffOverlay?.classList.add('hidden');
    // The status strip stays visible: it is the long-press target for the diagnostic log,
    // which is needed most when the camera has just failed.
    setStreamStatus('Not streaming', 'connecting');
    screenOffBtn?.classList.add('hidden');
    startBtn.disabled = false;
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
    let count = 0;
    if (room && room.state !== LK.ConnectionState.Disconnected) {
      room.remoteParticipants.forEach((participant) => {
        if (isViewer(participant)) count += 1;
      });
    }
    viewerCountEl.textContent = String(count);
  }

  function updateUptime() {
    if (!startTime || !statUptime) return;
    const s = Math.floor((Date.now() - startTime) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    statUptime.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
