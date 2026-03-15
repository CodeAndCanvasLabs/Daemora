/**
 * BrowserMeetingBot — Playwright-based meeting bot (rewrite based on Vexa patterns).
 *
 * Joins Google Meet, Teams, Zoom via browser automation.
 * Real-time audio capture via Web Audio API + ScriptProcessorNode → 16kHz resampling.
 * STT via configurable providers (Deepgram WebSocket, OpenAI Whisper batch, Groq).
 * Local fallback: accumulate audio → batch transcribe when no streaming STT available.
 * WAV recording to file.
 * Platform-specific join strategies with proper selectors.
 */

import { browserAction, getActivePage, getBrowserContext } from "../tools/browserAutomation.js";
import {
  _getRawSession,
  updateState,
  addTranscript,
  updateParticipants,
  setMuted as setSessionMuted,
} from "./MeetingSessionManager.js";
import { textToSpeech } from "../tools/textToSpeech.js";
import { readFileSync, writeFileSync, createWriteStream, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config/default.js";

// ── Audio capture script (injected into meeting page) ─────────────────────
// Based on Vexa's audio.ts — ScriptProcessorNode with 16kHz resampling.
// Sends Float32Array samples back to Node.js via page.exposeFunction.

const AUDIO_CAPTURE_SCRIPT = `
(function() {
  if (window.__daemoraCaptureActive) return "already-active";
  window.__daemoraCaptureActive = true;

  const TARGET_SAMPLE_RATE = 16000;

  // Find active audio/video elements with MediaStream tracks
  function findMediaElements() {
    const elements = [];
    document.querySelectorAll("audio, video").forEach(el => {
      if (!el.paused && el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0) {
        elements.push(el);
      }
    });
    return elements;
  }

  // Linear interpolation resampling (Vexa pattern)
  function resample(inputData, sourceSampleRate, targetSampleRate) {
    if (sourceSampleRate === targetSampleRate) return inputData;
    const targetLength = Math.round(inputData.length * (targetSampleRate / sourceSampleRate));
    const resampledData = new Float32Array(targetLength);
    const springFactor = (inputData.length - 1) / (targetLength - 1);
    resampledData[0] = inputData[0];
    resampledData[targetLength - 1] = inputData[inputData.length - 1];
    for (let i = 1; i < targetLength - 1; i++) {
      const index = i * springFactor;
      const leftIndex = Math.floor(index);
      const rightIndex = Math.ceil(index);
      const fraction = index - leftIndex;
      resampledData[i] = inputData[leftIndex] + (inputData[rightIndex] - inputData[leftIndex]) * fraction;
    }
    return resampledData;
  }

  // Retry finding media elements (they may load late)
  let retryCount = 0;
  const maxRetries = 30;

  function startCapture() {
    const elements = findMediaElements();
    if (elements.length === 0) {
      retryCount++;
      if (retryCount < maxRetries) {
        setTimeout(startCapture, 2000);
        return;
      }
      console.log("[Daemora] No audio elements found after " + maxRetries + " retries");
      return;
    }

    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();

      // Connect all media element sources to combined destination
      elements.forEach(el => {
        try {
          if (el.__daemoraHooked) return;
          el.__daemoraHooked = true;
          const source = ctx.createMediaStreamSource(el.srcObject);
          source.connect(dest);
        } catch(e) {}
      });

      // Also watch for NEW audio/video elements (late-joining participants)
      const observer = new MutationObserver(() => {
        document.querySelectorAll("audio, video").forEach(el => {
          if (el.__daemoraHooked) return;
          if (!el.paused && el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0) {
            el.__daemoraHooked = true;
            try {
              const source = ctx.createMediaStreamSource(el.srcObject);
              source.connect(dest);
            } catch(e) {}
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // ScriptProcessorNode for continuous audio capture
      const bufferSize = 4096;
      const recorder = ctx.createScriptProcessor(bufferSize, 1, 1);
      const sourceNode = ctx.createMediaStreamSource(dest.stream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;

      sourceNode.connect(recorder);
      recorder.connect(gainNode);
      gainNode.connect(ctx.destination);

      recorder.onaudioprocess = function(event) {
        const inputData = event.inputBuffer.getChannelData(0);
        const resampled = resample(inputData, ctx.sampleRate, TARGET_SAMPLE_RATE);

        // Convert Float32Array to regular array for JSON transfer
        if (window.__daemoraSendAudio) {
          const arr = Array.from(resampled);
          window.__daemoraSendAudio(JSON.stringify(arr));
        }
      };

      window.__daemoraCaptureCtx = ctx;
      window.__daemoraCaptureRecorder = recorder;
      window.__daemoraCaptureObserver = observer;
      console.log("[Daemora] Audio capture started (" + elements.length + " sources, " + ctx.sampleRate + "Hz -> 16000Hz)");
    } catch(e) {
      console.error("[Daemora] Audio capture error:", e);
    }
  }

  // Start with delay to let meeting fully load
  setTimeout(startCapture, 3000);
  return "capture-initializing";
})();
`;

// ── Teams RTCPeerConnection hook (inject BEFORE page loads) ─────────────
// Based on Vexa's teams/join.ts — intercepts WebRTC to create audio elements

const TEAMS_RTC_HOOK_SCRIPT = `
(function() {
  if (window.__daemoraRTCHooked) return;
  window.__daemoraRTCHooked = true;
  window.__daemoraInjectedAudioElements = [];

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = function(...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    pc.addEventListener('track', function(event) {
      if (event.track.kind === 'audio') {
        const audioEl = document.createElement('audio');
        audioEl.srcObject = new MediaStream([event.track]);
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
  window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
})();
`;

// ── Platform join strategies ──────────────────────────────────────────────

const platforms = {
  async meet(session) {
    const { meetingUrl, displayName, profileName } = session;
    await browserAction({ action: "newSession", param1: profileName });
    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(5000);

    const page = getActivePage();
    if (!page) throw new Error("No browser page available");

    // Fill display name
    try {
      const nameInput = await page.waitForSelector(
        'input[aria-label*="name" i], input[placeholder*="name" i], input[data-is-required="true"]',
        { timeout: 10000 }
      ).catch(() => null);
      if (nameInput) {
        await nameInput.fill(displayName);
        await _wait(500);
      }
    } catch {}

    // Turn off camera
    try {
      const camBtn = await page.$('[data-is-muted="false"][aria-label*="camera" i], [aria-label*="Turn off camera" i]');
      if (camBtn) await camBtn.click();
      await _wait(500);
    } catch {}

    // Click "Join now" or "Ask to join"
    try {
      const joinBtn = await page.waitForSelector(
        'button:has-text("Join now"), button:has-text("Ask to join"), button:has-text("Join")',
        { timeout: 15000 }
      );
      if (joinBtn) await joinBtn.click();
    } catch {}

    await _wait(5000);
    return "meet-joined";
  },

  async teams(session) {
    const { meetingUrl, displayName, profileName } = session;
    await browserAction({ action: "newSession", param1: profileName });

    // Inject RTCPeerConnection hook BEFORE navigating (crucial for Teams audio)
    const page = getActivePage();
    if (page) {
      await page.addInitScript(TEAMS_RTC_HOOK_SCRIPT);
    }

    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(5000);

    const activePage = getActivePage();
    if (!activePage) throw new Error("No browser page available");

    // Handle "Continue on this browser"
    try {
      const continueBtn = await activePage.$('button:has-text("Continue on this browser"), a:has-text("Continue on this browser"), button:has-text("Join on the web")');
      if (continueBtn) {
        await continueBtn.click();
        await _wait(3000);
      }
    } catch {}

    // Fill display name
    try {
      const nameInput = await activePage.waitForSelector(
        'input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i]',
        { timeout: 10000 }
      ).catch(() => null);
      if (nameInput) {
        await nameInput.fill(displayName);
        await _wait(500);
      }
    } catch {}

    // Turn off camera
    try {
      const camBtn = await activePage.$('[data-tid="toggle-video"], [aria-label*="camera" i], [aria-label*="Turn off video" i]');
      if (camBtn) await camBtn.click();
      await _wait(500);
    } catch {}

    // Ensure computer audio is selected
    try {
      const computerAudio = await activePage.$('input[value="computer-audio"], [data-tid="computer-audio"]');
      if (computerAudio) await computerAudio.click();
    } catch {}

    // Unmute all audio elements (Teams may mute them)
    await activePage.evaluate(() => {
      document.querySelectorAll("audio").forEach(el => {
        el.muted = false;
        el.autoplay = true;
        el.volume = 1.0;
        el.play().catch(() => {});
      });
    });

    // Click "Join now"
    try {
      const joinBtn = await activePage.waitForSelector(
        'button:has-text("Join now"), button[data-tid="prejoin-join-button"]',
        { timeout: 15000 }
      );
      if (joinBtn) await joinBtn.click();
    } catch {}

    await _wait(8000);
    return "teams-joined";
  },

  async zoom(session) {
    const { meetingUrl, displayName, profileName } = session;
    await browserAction({ action: "newSession", param1: profileName });

    // Convert zoom.us/j/xxx to web client URL
    let url = meetingUrl;
    if (url.includes("zoom.us/j/")) {
      const meetingId = url.match(/\/j\/(\d+)/)?.[1];
      if (meetingId) url = `https://app.zoom.us/wc/join/${meetingId}`;
    }

    await browserAction({ action: "navigate", param1: url });
    await _wait(3000);

    const page = getActivePage();
    if (!page) throw new Error("No browser page available");

    // Click "Join from Your Browser" if present
    try {
      const browserLink = await page.$('a:has-text("Join from Your Browser"), a:has-text("Join from browser")');
      if (browserLink) {
        await browserLink.click();
        await _wait(2000);
      }
    } catch {}

    // Fill display name
    try {
      const nameInput = await page.$('#inputname, [placeholder*="name" i], input[name="name"]');
      if (nameInput) {
        await nameInput.fill(displayName);
        await _wait(500);
      }
    } catch {}

    // Click Join
    try {
      const joinBtn = await page.$('[id*="joinBtn"], button:has-text("Join"), button[class*="join"]');
      if (joinBtn) await joinBtn.click();
    } catch {}

    await _wait(5000);
    return "zoom-joined";
  },

  async generic(session) {
    const { meetingUrl, profileName } = session;
    await browserAction({ action: "newSession", param1: profileName });
    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(3000);
    const snapshot = await browserAction({ action: "snapshot" });
    return `generic-navigated. Use snapshot to interact:\n${snapshot}`;
  },
};

// ── WAV Recording ────────────────────────────────────────────────────────

class WavRecorder {
  constructor(sessionId) {
    const dir = join(config.dataDir, "meetings");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `recording-${sessionId}-${Date.now()}.wav`);
    this.sampleRate = 16000;
    this.channels = 1;
    this.bitsPerSample = 16;
    this.totalSamples = 0;
    this.stream = null;
  }

  start() {
    this.stream = createWriteStream(this.path);
    // Write placeholder header (will be rewritten on finalize)
    this.stream.write(this._createHeader(0));
    this.totalSamples = 0;
  }

  /** Append Float32Array audio data */
  appendFloat32(float32Data) {
    if (!this.stream) return;
    const pcm = this._float32ToInt16(float32Data);
    this.stream.write(pcm);
    this.totalSamples += float32Data.length;
  }

  /** Finalize — rewrite header with correct sizes, close stream */
  async finalize() {
    if (!this.stream) return this.path;

    await new Promise(resolve => this.stream.end(resolve));

    // Rewrite header with actual data size
    const dataSize = this.totalSamples * 2; // 2 bytes per Int16 sample
    const header = this._createHeader(dataSize);
    const fd = openSync(this.path, "r+");
    writeSync(fd, header, 0, 44, 0);
    closeSync(fd);

    const durationSec = (this.totalSamples / this.sampleRate).toFixed(1);
    console.log(`[Meeting] Recording finalized: ${this.path} (${durationSec}s, ${this.totalSamples} samples)`);
    return this.path;
  }

  _float32ToInt16(float32Data) {
    const buffer = Buffer.alloc(float32Data.length * 2);
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      buffer.writeInt16LE(Math.round(val), i * 2);
    }
    return buffer;
  }

  _createHeader(dataSize) {
    const header = Buffer.alloc(44);
    const byteRate = this.sampleRate * this.channels * 2;
    const blockAlign = this.channels * 2;

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);                    // subchunk1Size
    header.writeUInt16LE(1, 20);                     // PCM format
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return header;
  }
}

// ── STT Integration ──────────────────────────────────────────────────────

/**
 * Batch transcription — accumulates audio, transcribes periodically.
 * Works with any provider that accepts audio files (OpenAI Whisper, Groq).
 * Fallback when no streaming WebSocket STT is available.
 */
class BatchTranscriber {
  constructor(sessionId, provider = "whisper") {
    this.sessionId = sessionId;
    this.provider = provider;
    this.audioBuffer = [];       // accumulated Float32Array chunks
    this.bufferDurationMs = 0;
    this.intervalMs = 10000;     // transcribe every 10 seconds
    this.timer = null;
    this.sampleRate = 16000;
  }

  start() {
    this.timer = setInterval(() => this._flush(), this.intervalMs);
  }

  addChunk(float32Data) {
    this.audioBuffer.push(float32Data);
    this.bufferDurationMs += (float32Data.length / this.sampleRate) * 1000;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this._flush(); // final flush
  }

  async _flush() {
    if (this.audioBuffer.length === 0) return;

    const chunks = this.audioBuffer.splice(0);
    this.bufferDurationMs = 0;

    // Merge chunks into single Float32Array
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to WAV buffer for STT API
    const wavBuffer = this._float32ToWav(merged);

    // Transcribe via configured provider
    try {
      const text = await this._transcribe(wavBuffer);
      if (text && text.trim()) {
        addTranscript(this.sessionId, { speaker: "participant", text: text.trim() });
        console.log(`[Meeting:STT] ${this.sessionId}: "${text.trim().slice(0, 100)}"`);
      }
    } catch (e) {
      console.log(`[Meeting:STT] Transcription error: ${e.message}`);
    }
  }

  async _transcribe(wavBuffer) {
    // Try OpenAI Whisper
    if (process.env.OPENAI_API_KEY) {
      return this._transcribeWhisper(wavBuffer);
    }
    // Try Groq Whisper
    if (process.env.GROQ_API_KEY) {
      return this._transcribeGroq(wavBuffer);
    }
    // No STT provider available
    console.log(`[Meeting:STT] No STT provider configured (set OPENAI_API_KEY or GROQ_API_KEY)`);
    return null;
  }

  async _transcribeWhisper(wavBuffer) {
    const formData = new FormData();
    formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.text;
  }

  async _transcribeGroq(wavBuffer) {
    const formData = new FormData();
    formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-large-v3");
    formData.append("language", "en");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData,
    });

    if (!res.ok) throw new Error(`Groq API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.text;
  }

  _float32ToWav(float32Data) {
    const dataSize = float32Data.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    const byteRate = this.sampleRate * 2;

    // WAV header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(this.sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    // PCM data
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      buffer.writeInt16LE(Math.round(val), 44 + i * 2);
    }

    return buffer;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Join a meeting via browser.
 */
export async function joinMeeting(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  updateState(sessionId, "joining");

  try {
    const strategy = platforms[session.platform] || platforms.generic;
    const result = await strategy(session);

    updateState(sessionId, "connected");

    // Start audio capture + transcription + recording
    await startAudioCapture(sessionId).catch(e => {
      console.log(`[Meeting] Audio capture failed for ${sessionId}: ${e.message}`);
    });

    return `Joined ${session.platform} meeting. ${result}`;
  } catch (e) {
    updateState(sessionId, "error", e.message);
    throw e;
  }
}

/**
 * Leave a meeting.
 */
export async function leaveMeeting(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  updateState(sessionId, "leaving");

  try {
    // Stop audio capture + transcription + recording
    await stopAudioCapture(sessionId);

    // Click leave/end button
    const page = getActivePage();
    if (page) {
      await page.evaluate(() => {
        const btns = document.querySelectorAll("button");
        for (const btn of btns) {
          const text = btn.textContent.toLowerCase();
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (text.includes("leave") || text.includes("end") || label.includes("leave") || label.includes("hang up")) {
            btn.click();
            break;
          }
        }
      });
      await _wait(2000);
    }

    await browserAction({ action: "close" });
    updateState(sessionId, "left");
    return `Left meeting ${sessionId}`;
  } catch (e) {
    updateState(sessionId, "left");
    return `Left meeting ${sessionId} (with errors: ${e.message})`;
  }
}

/**
 * Speak text in a meeting via TTS → audio injection.
 */
export async function speakInMeeting(sessionId, text) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.muted) return "Cannot speak — microphone is muted.";

  const ttsOpts = {
    text,
    provider: session.audioConfig.ttsProvider || "openai",
    format: "mp3",
  };
  if (session.audioConfig.voiceId) {
    ttsOpts.voiceId = session.audioConfig.voiceId;
    ttsOpts.provider = "elevenlabs";
  }

  const ttsResult = await textToSpeech(ttsOpts);
  if (ttsResult.startsWith("Error")) return ttsResult;

  const pathMatch = ttsResult.match(/saved to: (.+)/);
  if (!pathMatch) return `TTS failed: ${ttsResult}`;

  try {
    const audioBuffer = readFileSync(pathMatch[1]);
    const base64 = audioBuffer.toString("base64");
    const page = getActivePage();
    if (!page) return "Error: no browser page active";

    await page.evaluate((b64) => {
      (async function() {
        try {
          const ctx = window.__daemoraCaptureCtx || new AudioContext();
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          source.start();
        } catch (e) {
          console.error("[Daemora] Audio injection error:", e);
        }
      })();
    }, base64);

    addTranscript(sessionId, { speaker: session.displayName, text });
    return `Spoke: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
  } catch (e) {
    return `Audio injection failed: ${e.message}`;
  }
}

/**
 * Get recent transcript from a meeting.
 */
export function getTranscript(sessionId, last = 20) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const entries = session.transcript.slice(-last);
  if (entries.length === 0) return "No transcript entries yet.";

  return entries.map(e => {
    const time = new Date(e.timestamp).toISOString().slice(11, 19);
    return `[${time}] ${e.speaker}: ${e.text}`;
  }).join("\n");
}

/**
 * Get participants in a meeting.
 */
export async function getParticipants(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const page = getActivePage();
  if (page) {
    try {
      const result = await page.evaluate(() => {
        const participants = [];
        const selectors = [
          "[data-participant-id]",
          ".participant-item",
          "[class*='participant']",
          "[class*='attendee']",
          "[data-tid='roster-participant']",
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach(el => {
              const name = el.textContent.trim().split("\n")[0].trim();
              if (name && name.length < 100) participants.push(name);
            });
            break;
          }
        }
        return participants;
      });

      if (Array.isArray(result) && result.length > 0) {
        updateParticipants(sessionId, result.map(name => ({ name })));
        return `Participants (${result.length}):\n${result.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`;
      }
    } catch {}
  }

  const cached = [...session.participants.values()];
  if (cached.length > 0) {
    return `Participants (${cached.length}, cached):\n${cached.map((p, i) => `  ${i + 1}. ${p.name}`).join("\n")}`;
  }

  return "Could not detect participants. Try taking a snapshot of the meeting UI.";
}

/**
 * Toggle mute state.
 */
export async function toggleMute(sessionId, mute) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  setSessionMuted(sessionId, mute);

  const page = getActivePage();
  if (page) {
    try {
      await page.evaluate(() => {
        const btns = document.querySelectorAll("button");
        for (const btn of btns) {
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (label.includes("mute") || label.includes("microphone")) {
            btn.click();
            break;
          }
        }
      });
    } catch {}
  }

  return mute ? "Microphone muted." : "Microphone unmuted.";
}

/**
 * Get recording path for a session.
 */
export function getRecording(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (!session._wavRecorder) return "No recording available.";
  return `Recording: ${session._wavRecorder.path}`;
}

// ── Audio capture lifecycle ──────────────────────────────────────────────

async function startAudioCapture(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  const page = getActivePage();
  if (!page) {
    console.log(`[Meeting] No page available for audio capture`);
    return;
  }

  // Initialize WAV recorder
  const recorder = new WavRecorder(sessionId);
  recorder.start();
  session._wavRecorder = recorder;

  // Initialize batch transcriber
  const transcriber = new BatchTranscriber(sessionId, session.audioConfig.sttProvider);
  transcriber.start();
  session._transcriber = transcriber;

  // Expose function to receive audio chunks from browser
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      try {
        const arr = JSON.parse(jsonChunk);
        const float32 = new Float32Array(arr);

        // Feed to WAV recorder
        recorder.appendFloat32(float32);

        // Feed to STT transcriber
        transcriber.addChunk(float32);
      } catch {}
    });
  } catch (e) {
    // exposeFunction may fail if already exposed (page reload)
    console.log(`[Meeting] exposeFunction warning: ${e.message}`);
  }

  // Inject audio capture script
  const result = await browserAction({ action: "evaluate", param1: AUDIO_CAPTURE_SCRIPT });
  console.log(`[Meeting] Audio capture for ${sessionId}: ${result}`);

  updateState(sessionId, "active");
}

async function stopAudioCapture(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  // Stop browser-side capture
  try {
    const page = getActivePage();
    if (page) {
      await page.evaluate(() => {
        if (window.__daemoraCaptureRecorder) {
          window.__daemoraCaptureRecorder.disconnect();
          window.__daemoraCaptureActive = false;
        }
        if (window.__daemoraCaptureObserver) {
          window.__daemoraCaptureObserver.disconnect();
        }
      });
    }
  } catch {}

  // Stop transcriber
  if (session._transcriber) {
    session._transcriber.stop();
    session._transcriber = null;
  }

  // Finalize recording
  if (session._wavRecorder) {
    const path = await session._wavRecorder.finalize();
    console.log(`[Meeting] Recording saved: ${path}`);
  }
}

function _wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
