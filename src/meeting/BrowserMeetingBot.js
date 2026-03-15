/**
 * BrowserMeetingBot — orchestrator for meeting bot lifecycle.
 *
 * Production-grade implementation based on Vexa patterns.
 * Delegates to modular services:
 *   - platforms/googlemeet.js, teams.js, zoom.js — platform-specific join/leave/selectors
 *   - services/AudioCapture.js — browser-side audio capture scripts
 *   - services/Transcriber.js — batch STT (Whisper/Groq/local)
 *   - services/WavRecorder.js — WAV file writing
 *
 * Flow: join → start audio capture → transcribe → record → leave → finalize
 */

import { browserAction, getActivePage } from "../tools/browserAutomation.js";
import {
  _getRawSession,
  updateState,
  addTranscript,
  updateParticipants,
  setMuted as setSessionMuted,
} from "./MeetingSessionManager.js";
import { textToSpeech } from "../tools/textToSpeech.js";
import { readFileSync } from "node:fs";
import { AUDIO_CAPTURE_SCRIPT, AUDIO_STOP_SCRIPT, TEAMS_RTC_HOOK_SCRIPT } from "./services/AudioCapture.js";
import WavRecorder from "./services/WavRecorder.js";
import Transcriber from "./services/Transcriber.js";
import { joinGoogleMeet, leaveGoogleMeet, startRemovalMonitor as meetRemovalMonitor } from "./platforms/googlemeet.js";
import { joinTeams, leaveTeams, startRemovalMonitor as teamsRemovalMonitor } from "./platforms/teams.js";
import { joinZoom, leaveZoom, startRemovalMonitor as zoomRemovalMonitor } from "./platforms/zoom.js";

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Join a meeting via browser.
 */
export async function joinMeeting(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  updateState(sessionId, "joining");

  try {
    // Start browser with meeting profile
    await browserAction({ action: "newSession", param1: session.profileName });

    const page = getActivePage();
    if (!page) throw new Error("No browser page available after launch");

    // Teams needs RTCPeerConnection hook BEFORE navigation
    if (session.platform === "teams") {
      await page.addInitScript(TEAMS_RTC_HOOK_SCRIPT);
      console.log("[Meeting] Teams RTC hook injected");
    }

    // Platform-specific join
    let joinResult;
    switch (session.platform) {
      case "meet":
        joinResult = await joinGoogleMeet(page, session);
        break;
      case "teams":
        joinResult = await joinTeams(page, session);
        break;
      case "zoom":
        joinResult = await joinZoom(page, session);
        break;
      default:
        // Generic — navigate and let the agent figure it out
        await page.goto(session.meetingUrl, { waitUntil: "networkidle", timeout: 60000 });
        await _wait(3000);
        joinResult = "generic-navigated";
    }

    // Handle join result
    if (joinResult === "rejected" || joinResult === "auth-required") {
      updateState(sessionId, "error", `Join failed: ${joinResult}`);
      return `Failed to join: ${joinResult}. Check if the meeting allows external participants or use an authenticated browser profile.`;
    }
    if (joinResult === "admission-timeout") {
      updateState(sessionId, "error", "Host did not admit bot within 2 minutes");
      return "Failed: host did not admit the bot. Ask the host to admit 'Daemora' from the meeting.";
    }
    if (joinResult === "no-join-button") {
      updateState(sessionId, "error", "Could not find join button");
      return "Failed: could not find join button. Check debug screenshots in data/meetings/.";
    }

    updateState(sessionId, "connected");

    // Start services (audio capture, transcription, recording, removal monitoring)
    await startServices(sessionId);

    return `Joined ${session.platform} meeting (${joinResult}).\nSession ID: ${sessionId} | Platform: ${session.platform}`;
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
    // Stop services
    await stopServices(sessionId);

    // Platform-specific leave
    const page = getActivePage();
    if (page) {
      switch (session.platform) {
        case "meet": await leaveGoogleMeet(page); break;
        case "teams": await leaveTeams(page); break;
        case "zoom": await leaveZoom(page); break;
        default:
          await page.evaluate(() => {
            const btns = document.querySelectorAll("button");
            for (const btn of btns) {
              const t = btn.textContent.toLowerCase();
              const l = (btn.getAttribute("aria-label") || "").toLowerCase();
              if (t.includes("leave") || l.includes("leave") || l.includes("hang up")) {
                btn.click(); return;
              }
            }
          });
      }
      await _wait(2000);
    }

    await browserAction({ action: "close" });
    updateState(sessionId, "left");

    // Return summary
    const transcriptCount = session.transcript.length;
    const recordingPath = session._wavRecorder?.path || null;
    return `Left meeting ${sessionId}. ${transcriptCount} transcript entries captured.${recordingPath ? ` Recording: ${recordingPath}` : ""}`;
  } catch (e) {
    updateState(sessionId, "left");
    return `Left meeting ${sessionId} (with errors: ${e.message})`;
  }
}

/**
 * Speak text in meeting via TTS → audio injection.
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

  const page = getActivePage();
  if (!page) return "Error: no browser page active";

  try {
    const audioBuffer = readFileSync(pathMatch[1]);
    const base64 = audioBuffer.toString("base64");

    await page.evaluate((b64) => {
      (async function() {
        try {
          const ctx = window.__daemoraCaptureCtx || new AudioContext();
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const buf = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = buf;
          source.connect(ctx.destination);
          source.start();
        } catch (e) { console.error("[Daemora:TTS]", e); }
      })();
    }, base64);

    addTranscript(sessionId, { speaker: session.displayName, text });
    return `Spoke: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
  } catch (e) {
    return `Audio injection failed: ${e.message}`;
  }
}

/**
 * Get recent transcript.
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
 * Get participants.
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
          "[data-participant-id]", ".participant-item",
          "[class*='participant']", "[class*='attendee']",
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
  return "Could not detect participants.";
}

/**
 * Toggle mute.
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
            btn.click(); return;
          }
        }
      });
    } catch {}
  }
  return mute ? "Microphone muted." : "Microphone unmuted.";
}

/**
 * Get recording file path.
 */
export function getRecording(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (!session._wavRecorder) return "No recording available.";
  return `Recording: ${session._wavRecorder.path}`;
}

// ── Service lifecycle ────────────────────────────────────────────────────

async function startServices(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  const page = getActivePage();
  if (!page) {
    console.log("[Meeting] No page for audio capture");
    return;
  }

  // 1. WAV Recorder
  const recorder = new WavRecorder(sessionId);
  recorder.start();
  session._wavRecorder = recorder;

  // 2. Transcriber
  const transcriber = new Transcriber(sessionId, {
    onTranscript: (entry) => addTranscript(sessionId, entry),
    flushIntervalMs: 10000,
  });
  transcriber.start();
  session._transcriber = transcriber;

  // 3. Expose audio callback + inject capture script
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      try {
        const arr = JSON.parse(jsonChunk);
        const float32 = new Float32Array(arr);
        recorder.appendFloat32(float32);
        transcriber.addChunk(float32);
      } catch {}
    });
  } catch (e) {
    console.log(`[Meeting] exposeFunction: ${e.message}`);
  }

  const captureResult = await page.evaluate(AUDIO_CAPTURE_SCRIPT);
  console.log(`[Meeting] Audio capture: ${captureResult}`);

  // 4. Removal monitor
  const stopMonitor = session.platform === "meet"
    ? meetRemovalMonitor(page, (reason) => {
        console.log(`[Meeting] Removed from meeting: ${reason}`);
        stopServices(sessionId).then(() => {
          updateState(sessionId, "left");
        });
      })
    : session.platform === "teams"
      ? teamsRemovalMonitor(page, (reason) => {
          stopServices(sessionId).then(() => updateState(sessionId, "left"));
        })
      : session.platform === "zoom"
        ? zoomRemovalMonitor(page, (reason) => {
            stopServices(sessionId).then(() => updateState(sessionId, "left"));
          })
        : () => {};
  session._stopRemovalMonitor = stopMonitor;

  updateState(sessionId, "active");
}

async function stopServices(sessionId) {
  const session = _getRawSession(sessionId);
  if (!session) return;

  // Stop removal monitor
  if (session._stopRemovalMonitor) {
    session._stopRemovalMonitor();
    session._stopRemovalMonitor = null;
  }

  // Stop audio capture in browser
  try {
    const page = getActivePage();
    if (page) await page.evaluate(AUDIO_STOP_SCRIPT);
  } catch {}

  // Stop transcriber (flushes remaining audio)
  if (session._transcriber) {
    await session._transcriber.stop();
    session._transcriber = null;
  }

  // Finalize WAV recording
  if (session._wavRecorder) {
    await session._wavRecorder.finalize();
  }
}
