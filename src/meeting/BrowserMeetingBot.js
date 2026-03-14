/**
 * BrowserMeetingBot — Playwright-based meeting bot.
 *
 * Joins meetings via browser with persistent profiles (reuses browserAutomation profile infra).
 * Captures audio via CDP Web Audio API injection.
 * Injects audio (TTS) back via Web Audio API AudioBufferSourceNode.
 *
 * Platform-specific join strategies for Zoom, Google Meet, Teams.
 * Generic fallback for any browser-accessible meeting platform.
 */

import { browserAction } from "../tools/browserAutomation.js";
import {
  _getRawSession,
  updateState,
  addTranscript,
  updateParticipants,
  setMuted as setSessionMuted,
} from "./MeetingSessionManager.js";
import { textToSpeech } from "../tools/textToSpeech.js";
import tenantContext from "../tenants/TenantContext.js";
import { readFileSync } from "node:fs";

// ── Audio capture script (injected into meeting page) ─────────────────────
// Creates AudioContext, captures from page's audio output, chunks into segments,
// sends base64 audio data back to Node.js via exposed function.

const AUDIO_CAPTURE_SCRIPT = `
(function() {
  if (window.__daemoraCaptureActive) return "already-active";
  window.__daemoraCaptureActive = true;

  const ctx = new AudioContext({ sampleRate: 16000 });
  const dest = ctx.createMediaStreamDestination();

  // Capture ALL audio on the page by intercepting AudioContext
  const origCreate = AudioContext.prototype.createMediaStreamSource;
  const origElementSource = AudioContext.prototype.createMediaElementSource;

  // Hook into any audio sources created by the meeting platform
  const observer = new MutationObserver(() => {
    document.querySelectorAll("audio, video").forEach(el => {
      if (el.__daemoraHooked) return;
      el.__daemoraHooked = true;
      try {
        const source = ctx.createMediaElementSource(el);
        source.connect(dest);
        source.connect(ctx.destination); // keep playing to speakers
      } catch {}
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also try to capture via navigator.mediaDevices
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await origGetUserMedia(constraints);
    if (constraints.audio) {
      try {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(dest);
      } catch {}
    }
    return stream;
  };

  // Record chunks and send to Node.js
  const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];

  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const buffer = await e.data.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      if (window.__daemoraSendAudio) {
        window.__daemoraSendAudio(base64);
      }
    }
  };

  recorder.start(5000); // 5-second chunks
  window.__daemoraCaptureRecorder = recorder;
  window.__daemoraCaptureCtx = ctx;
  return "capture-started";
})();
`;

// ── Audio injection script template ───────────────────────────────────────
// Decodes base64 audio and plays it through the page's audio output

function buildAudioInjectionScript(base64Audio) {
  return `
(async function() {
  try {
    const ctx = window.__daemoraCaptureCtx || new AudioContext();
    const binary = atob("${base64Audio}");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();
    return "playing";
  } catch (e) {
    return "error: " + e.message;
  }
})();
`;
}

// ── Platform-specific join strategies ─────────────────────────────────────

const joinStrategies = {
  async zoom(session) {
    const { meetingUrl, displayName, profileName } = session;

    // Start browser with meeting profile
    await browserAction({ action: "newSession", param1: profileName });

    // Navigate to Zoom web client
    let url = meetingUrl;
    // Convert zoom.us/j/xxx to web client URL
    if (url.includes("zoom.us/j/")) {
      const meetingId = url.match(/\/j\/(\d+)/)?.[1];
      if (meetingId) url = `https://app.zoom.us/wc/join/${meetingId}`;
    }

    await browserAction({ action: "navigate", param1: url });
    await _wait(3000);

    // Look for "Join from Your Browser" link
    try {
      const snapshot = await browserAction({ action: "snapshot", param1: '{"interactive":true}' });
      // Try clicking "Join from Your Browser" if present
      await browserAction({ action: "evaluate", param1: `
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent.toLowerCase().includes('join from your browser') ||
              link.textContent.toLowerCase().includes('join from browser')) {
            link.click();
            break;
          }
        }
      `});
      await _wait(2000);
    } catch {}

    // Fill display name if prompted
    try {
      await browserAction({ action: "evaluate", param1: `
        const nameInput = document.querySelector('#inputname, [placeholder*="name"], input[name="name"]');
        if (nameInput) {
          nameInput.value = "${displayName}";
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `});
    } catch {}

    // Click Join button
    try {
      await browserAction({ action: "evaluate", param1: `
        const btn = document.querySelector('[id*="joinBtn"], button[class*="join"], button:has-text("Join")');
        if (btn) btn.click();
      `});
    } catch {}

    await _wait(5000);
    return "zoom-join-attempted";
  },

  async meet(session) {
    const { meetingUrl, displayName, profileName } = session;

    await browserAction({ action: "newSession", param1: profileName });
    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(5000);

    // Dismiss "Ready to join" page: disable camera, enable mic
    try {
      // Turn off camera
      await browserAction({ action: "evaluate", param1: `
        const camBtn = document.querySelector('[data-is-muted="false"][aria-label*="camera"], [aria-label*="Turn off camera"]');
        if (camBtn) camBtn.click();
      `});
      await _wait(1000);

      // Enter display name if field exists
      await browserAction({ action: "evaluate", param1: `
        const nameInput = document.querySelector('input[aria-label*="name"], input[placeholder*="name"]');
        if (nameInput && !nameInput.value) {
          nameInput.value = "${displayName}";
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `});

      // Click "Join now" / "Ask to join"
      await browserAction({ action: "evaluate", param1: `
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent.toLowerCase();
          if (text.includes('join now') || text.includes('ask to join')) {
            btn.click();
            break;
          }
        }
      `});
    } catch {}

    await _wait(5000);
    return "meet-join-attempted";
  },

  async teams(session) {
    const { meetingUrl, displayName, profileName } = session;

    await browserAction({ action: "newSession", param1: profileName });
    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(5000);

    // Handle "Continue on this browser" prompt
    try {
      await browserAction({ action: "evaluate", param1: `
        const btns = document.querySelectorAll('button, a');
        for (const btn of btns) {
          const text = btn.textContent.toLowerCase();
          if (text.includes('continue on this browser') || text.includes('join on the web')) {
            btn.click();
            break;
          }
        }
      `});
      await _wait(3000);

      // Enter display name
      await browserAction({ action: "evaluate", param1: `
        const nameInput = document.querySelector('input[data-tid="prejoin-display-name-input"], input[placeholder*="name"]');
        if (nameInput) {
          nameInput.value = "${displayName}";
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `});

      // Toggle audio on, camera off
      await browserAction({ action: "evaluate", param1: `
        const camToggle = document.querySelector('[data-tid="toggle-video"], [aria-label*="camera"]');
        if (camToggle) camToggle.click();
      `});
      await _wait(1000);

      // Click "Join now"
      await browserAction({ action: "evaluate", param1: `
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent.toLowerCase().includes('join now')) {
            btn.click();
            break;
          }
        }
      `});
    } catch {}

    await _wait(5000);
    return "teams-join-attempted";
  },

  async generic(session) {
    const { meetingUrl, profileName } = session;
    await browserAction({ action: "newSession", param1: profileName });
    await browserAction({ action: "navigate", param1: meetingUrl });
    await _wait(3000);
    // Take snapshot for agent to manually interact
    const snapshot = await browserAction({ action: "snapshot" });
    return `generic-navigated. Snapshot:\n${snapshot}`;
  },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Join a meeting via browser.
 * @param {string} sessionId
 * @returns {Promise<string>} Status message
 */
export async function joinMeeting(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  updateState(sessionId, "joining");

  try {
    const strategy = joinStrategies[session.platform] || joinStrategies.generic;
    const result = await strategy(session);

    updateState(sessionId, "connected");

    // Start audio capture
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
 * @param {string} sessionId
 */
export async function leaveMeeting(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  updateState(sessionId, "leaving");

  try {
    // Stop audio capture
    await stopAudioCapture(sessionId).catch(() => {});

    // Click leave/end button
    await browserAction({ action: "evaluate", param1: `
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent.toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('leave') || text.includes('end') || label.includes('leave') || label.includes('hang up')) {
          btn.click();
          break;
        }
      }
    `});

    await _wait(2000);
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
 * @param {string} sessionId
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function speakInMeeting(sessionId, text) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.muted) return "Cannot speak — microphone is muted.";

  // Generate TTS audio
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

  // Extract file path from TTS result
  const pathMatch = ttsResult.match(/saved to: (.+)/);
  if (!pathMatch) return `TTS failed: ${ttsResult}`;

  // Read audio file and inject into browser
  try {
    const audioBuffer = readFileSync(pathMatch[1]);
    const base64 = audioBuffer.toString("base64");
    const script = buildAudioInjectionScript(base64);
    const result = await browserAction({ action: "evaluate", param1: script });

    // Add to transcript
    addTranscript(sessionId, { speaker: session.displayName, text });

    return `Spoke: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
  } catch (e) {
    return `Audio injection failed: ${e.message}`;
  }
}

/**
 * Get recent transcript from a meeting.
 * @param {string} sessionId
 * @param {number} [last=20]
 * @returns {string}
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
 * @param {string} sessionId
 */
export async function getParticipants(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  // Try to extract participants from the meeting UI
  try {
    const result = await browserAction({ action: "evaluate", param1: `
      // Generic participant extraction — works for most platforms
      const participants = [];
      const selectors = [
        '[data-participant-id]',
        '.participant-item',
        '[class*="participant"]',
        '[class*="attendee"]',
        '[data-tid="roster-participant"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach(el => {
            const name = el.textContent.trim().split('\\n')[0].trim();
            if (name && name.length < 100) participants.push(name);
          });
          break;
        }
      }
      participants;
    `});

    const parsed = JSON.parse(result);
    if (Array.isArray(parsed) && parsed.length > 0) {
      updateParticipants(sessionId, parsed.map(name => ({ name })));
      return `Participants (${parsed.length}):\n${parsed.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`;
    }
  } catch {}

  // Fallback to cached participants
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

  // Try to click mute button in the meeting UI
  try {
    await browserAction({ action: "evaluate", param1: `
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('mute') || label.includes('microphone')) {
          btn.click();
          break;
        }
      }
    `});
  } catch {}

  return mute ? "Microphone muted." : "Microphone unmuted.";
}

// ── Audio capture ─────────────────────────────────────────────────────────

async function startAudioCapture(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  // Expose function for receiving audio chunks from browser
  // Note: This is a simplified version — production would use Deepgram WebSocket streaming
  try {
    const page = await _getCurrentPage();
    if (!page) return;

    await page.exposeFunction("__daemoraSendAudio", async (base64Chunk) => {
      try {
        // In production: stream to Deepgram/Whisper for real-time STT
        // For now: accumulate and batch transcribe
        if (!session._audioCapture) session._audioCapture = { chunks: [], lastProcessed: Date.now() };
        session._audioCapture.chunks.push(base64Chunk);

        // Process every 10 seconds of accumulated audio
        if (session._audioCapture.chunks.length >= 2) {
          const chunks = session._audioCapture.chunks.splice(0);
          session._audioCapture.lastProcessed = Date.now();
          // Batch STT would happen here
          console.log(`[Meeting] ${sessionId}: ${chunks.length} audio chunks ready for STT`);
        }
      } catch {}
    });

    // Inject capture script
    const result = await browserAction({ action: "evaluate", param1: AUDIO_CAPTURE_SCRIPT });
    console.log(`[Meeting] Audio capture for ${sessionId}: ${result}`);

    updateState(sessionId, "active");
  } catch (e) {
    console.log(`[Meeting] Audio capture setup failed: ${e.message}`);
  }
}

async function stopAudioCapture(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  try {
    await browserAction({ action: "evaluate", param1: `
      if (window.__daemoraCaptureRecorder) {
        window.__daemoraCaptureRecorder.stop();
        window.__daemoraCaptureActive = false;
      }
    `});
  } catch {}

  session._audioCapture = null;
}

async function _getCurrentPage() {
  // The browserAction module manages the page — we just need it for exposeFunction
  // This is a best-effort approach
  try {
    const status = await browserAction({ action: "status" });
    if (status.includes("not running")) return null;
    return true; // page exists
  } catch {
    return null;
  }
}

function _wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
