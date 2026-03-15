/**
 * AudioCapture — browser-side audio capture via Web Audio API.
 *
 * Based on Vexa's audio.ts pattern:
 * 1. Find active <audio>/<video> elements with MediaStream audio tracks
 * 2. Create AudioContext + ScriptProcessorNode for continuous PCM capture
 * 3. Resample to 16kHz via linear interpolation
 * 4. Forward Float32Array chunks to Node.js via page.exposeFunction
 * 5. MutationObserver watches for new audio elements (late joiners)
 *
 * GainNode set to 0 — audio doesn't loop back into meeting.
 */

/**
 * Browser-side audio capture script.
 * Injected via page.evaluate() after meeting is joined.
 * Calls window.__daemoraSendAudio(jsonChunk) with resampled Float32 data.
 */
export const AUDIO_CAPTURE_SCRIPT = `
(function() {
  if (window.__daemoraCaptureActive) return "already-active";
  window.__daemoraCaptureActive = true;

  const TARGET_SAMPLE_RATE = 16000;
  const BUFFER_SIZE = 4096;
  let sessionAudioStartTime = null;

  // ── Find media elements with active audio tracks ──────────────────────
  function findMediaElements() {
    const elements = [];
    document.querySelectorAll("audio, video").forEach(el => {
      if (!el.paused && el.srcObject instanceof MediaStream &&
          el.srcObject.getAudioTracks().length > 0) {
        elements.push(el);
      }
    });
    return elements;
  }

  // ── Linear interpolation resampling (Vexa pattern) ────────────────────
  function resample(inputData, sourceSampleRate, targetSampleRate) {
    if (sourceSampleRate === targetSampleRate) return inputData;
    const targetLength = Math.round(inputData.length * (targetSampleRate / sourceSampleRate));
    if (targetLength <= 2) return inputData;
    const resampledData = new Float32Array(targetLength);
    const springFactor = (inputData.length - 1) / (targetLength - 1);
    resampledData[0] = inputData[0];
    resampledData[targetLength - 1] = inputData[inputData.length - 1];
    for (let i = 1; i < targetLength - 1; i++) {
      const index = i * springFactor;
      const leftIndex = Math.floor(index);
      const rightIndex = Math.ceil(index);
      const fraction = index - leftIndex;
      resampledData[i] = inputData[leftIndex] +
        (inputData[rightIndex] - inputData[leftIndex]) * fraction;
    }
    return resampledData;
  }

  // ── Retry loop to find media elements (they may load late) ────────────
  let retryCount = 0;
  const MAX_RETRIES = 30; // 30 × 2s = 60s max wait
  const RETRY_INTERVAL_MS = 2000;

  function attemptCapture() {
    const elements = findMediaElements();
    if (elements.length === 0) {
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        console.log("[Daemora:Audio] No audio elements found, retry " + retryCount + "/" + MAX_RETRIES);
        setTimeout(attemptCapture, RETRY_INTERVAL_MS);
        return;
      }
      console.error("[Daemora:Audio] No audio elements found after " + MAX_RETRIES + " retries");
      window.__daemoraCaptureActive = false;
      return;
    }

    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      let connectedCount = 0;

      // Connect all media element audio sources to combined destination
      elements.forEach(el => {
        if (el.__daemoraHooked) return;
        el.__daemoraHooked = true;
        try {
          const source = ctx.createMediaStreamSource(el.srcObject);
          source.connect(dest);
          connectedCount++;
        } catch (e) {
          console.warn("[Daemora:Audio] Failed to connect source:", e.message);
        }
      });

      // MutationObserver for late-joining participants (new audio/video elements)
      const observer = new MutationObserver(() => {
        document.querySelectorAll("audio, video").forEach(el => {
          if (el.__daemoraHooked) return;
          if (!el.paused && el.srcObject instanceof MediaStream &&
              el.srcObject.getAudioTracks().length > 0) {
            el.__daemoraHooked = true;
            try {
              const source = ctx.createMediaStreamSource(el.srcObject);
              source.connect(dest);
              console.log("[Daemora:Audio] New audio source connected (late joiner)");
            } catch (e) {}
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // ScriptProcessorNode for continuous PCM capture
      const recorder = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      const sourceNode = ctx.createMediaStreamSource(dest.stream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0; // MUTED — don't loop audio back (Vexa pattern)

      sourceNode.connect(recorder);
      recorder.connect(gainNode);
      gainNode.connect(ctx.destination);

      recorder.onaudioprocess = function(event) {
        if (!sessionAudioStartTime) sessionAudioStartTime = Date.now();
        const inputData = event.inputBuffer.getChannelData(0);
        const resampled = resample(inputData, ctx.sampleRate, TARGET_SAMPLE_RATE);

        if (window.__daemoraSendAudio) {
          try {
            window.__daemoraSendAudio(JSON.stringify(Array.from(resampled)));
          } catch (e) {}
        }
      };

      window.__daemoraCaptureCtx = ctx;
      window.__daemoraCaptureRecorder = recorder;
      window.__daemoraCaptureObserver = observer;
      window.__daemoraCaptureGain = gainNode;

      console.log("[Daemora:Audio] Capture started — " + connectedCount + " sources, " +
        ctx.sampleRate + "Hz → " + TARGET_SAMPLE_RATE + "Hz");
    } catch (e) {
      console.error("[Daemora:Audio] Capture setup error:", e);
      window.__daemoraCaptureActive = false;
    }
  }

  // Start after 3s delay to let meeting fully render audio elements
  setTimeout(attemptCapture, 3000);
  return "capture-initializing";
})();
`;

/**
 * Stop audio capture script. Injected via page.evaluate() on leave.
 */
export const AUDIO_STOP_SCRIPT = `
(function() {
  if (window.__daemoraCaptureRecorder) {
    window.__daemoraCaptureRecorder.disconnect();
    window.__daemoraCaptureRecorder = null;
  }
  if (window.__daemoraCaptureObserver) {
    window.__daemoraCaptureObserver.disconnect();
    window.__daemoraCaptureObserver = null;
  }
  if (window.__daemoraCaptureCtx) {
    window.__daemoraCaptureCtx.close().catch(() => {});
    window.__daemoraCaptureCtx = null;
  }
  window.__daemoraCaptureActive = false;
  return "capture-stopped";
})();
`;

/**
 * Universal RTCPeerConnection hook — injected BEFORE page loads via addInitScript.
 * Tracks all PeerConnections for:
 * 1. Teams: mirror remote audio tracks into hidden <audio> elements
 * 2. TTS: replace audio sender track with TTS audio for speaking
 * Based on Vexa's teams/join.ts.
 */
export const RTC_HOOK_SCRIPT = `
(function() {
  if (window.__daemoraRTCHooked) return;
  window.__daemoraRTCHooked = true;
  window.__daemoraPeerConnections = [];
  window.__daemoraInjectedAudioElements = [];

  const OrigRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = function(...args) {
    const pc = new OrigRTC(...args);
    window.__daemoraPeerConnections.push(pc);

    pc.addEventListener('track', function(event) {
      if (event.track.kind === 'audio') {
        const stream = new MediaStream([event.track]);
        const audioEl = document.createElement('audio');
        audioEl.srcObject = stream;
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1.0;
        audioEl.dataset.daemoraInjected = 'true';
        audioEl.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;';
        document.body.appendChild(audioEl);
        audioEl.play().catch(() => {});
        window.__daemoraInjectedAudioElements.push(audioEl);
      }
    });

    return pc;
  };
  window.RTCPeerConnection.prototype = OrigRTC.prototype;
})();
`;

// Alias for backward compat
export const TEAMS_RTC_HOOK_SCRIPT = RTC_HOOK_SCRIPT;
