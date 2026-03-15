/**
 * MeetingTTS — Text-to-Speech for meetings via PulseAudio virtual microphone.
 *
 * Based on Vexa's tts-playback.ts pattern:
 * 1. TTS API generates audio (PCM/MP3/WAV)
 * 2. Audio plays through PulseAudio virtual sink → virtual mic
 * 3. Chromium picks up virtual mic as its microphone input
 * 4. WebRTC sends it to meeting participants
 *
 * Fallback chain:
 * 1. PulseAudio (participants CAN hear) — requires `pulseaudio` installed
 * 2. Web Audio injection (participants may NOT hear) — works everywhere
 *
 * Auto-setup: creates PulseAudio virtual devices on first use.
 */

import { execSync, spawn } from "node:child_process";
import { textToSpeech } from "../../tools/textToSpeech.js";
import { readFileSync } from "node:fs";
import { addTranscript } from "../MeetingSessionManager.js";

let pulseAudioAvailable = null; // null = untested
let pulseAudioSetup = false;

/**
 * Auto-install and start PulseAudio if not present.
 * Works on macOS (Homebrew), Linux (apt/dnf/pacman), Docker.
 * Called automatically on first meeting join — user doesn't need to do anything.
 */
function autoInstallPulseAudio() {
  const platform = process.platform;

  try {
    // Check if already installed
    execSync("paplay --version", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {}

  console.log("[MeetingTTS] PulseAudio not found — auto-installing...");

  try {
    if (platform === "darwin") {
      // macOS — Homebrew
      execSync("which brew", { stdio: "ignore", timeout: 3000 });
      execSync("brew install pulseaudio 2>/dev/null || true", { stdio: "inherit", timeout: 120000 });
    } else if (platform === "linux") {
      // Linux — try package managers in order
      try {
        execSync("apt-get install -y pulseaudio pulseaudio-utils 2>/dev/null", { stdio: "ignore", timeout: 120000 });
      } catch {
        try {
          execSync("dnf install -y pulseaudio pulseaudio-utils 2>/dev/null", { stdio: "ignore", timeout: 120000 });
        } catch {
          try {
            execSync("pacman -S --noconfirm pulseaudio 2>/dev/null", { stdio: "ignore", timeout: 120000 });
          } catch {
            console.log("[MeetingTTS] Could not auto-install PulseAudio on this Linux distro");
            return false;
          }
        }
      }
    } else if (platform === "win32") {
      // Windows — check for VB-Cable virtual audio device
      try {
        execSync("powershell -Command \"Get-PnpDevice -FriendlyName '*CABLE*' -ErrorAction SilentlyContinue\"", { stdio: "ignore", timeout: 5000 });
        console.log("[MeetingTTS] VB-Cable detected on Windows");
        pulseAudioAvailable = false; // Can't use paplay on Windows, but VB-Cable works differently
        return false; // TODO: implement VB-Cable audio routing
      } catch {}
      console.log("[MeetingTTS] Windows: install VB-Cable for meeting speaking → https://vb-audio.com/Cable/");
      return false;
    } else {
      console.log(`[MeetingTTS] Auto-install not supported on ${platform}`);
      return false;
    }

    // Verify install succeeded
    execSync("paplay --version", { stdio: "ignore", timeout: 3000 });
    console.log("[MeetingTTS] PulseAudio installed successfully");
    return true;
  } catch (e) {
    console.log(`[MeetingTTS] Auto-install failed: ${e.message}`);
    return false;
  }
}

/**
 * Ensure PulseAudio daemon is running.
 */
function ensurePulseAudioRunning() {
  try {
    // Check if already running
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {}

  // Start PulseAudio daemon
  try {
    execSync("pulseaudio --start --exit-idle-time=-1 2>/dev/null || pulseaudio -D 2>/dev/null || true", {
      stdio: "ignore", timeout: 10000,
    });
    // Wait for it to be ready
    for (let i = 0; i < 10; i++) {
      try {
        execSync("pactl info", { stdio: "ignore", timeout: 2000 });
        console.log("[MeetingTTS] PulseAudio daemon started");
        return true;
      } catch {}
      execSync("sleep 0.5", { stdio: "ignore" });
    }
  } catch {}

  console.log("[MeetingTTS] Could not start PulseAudio daemon");
  return false;
}

/**
 * Check if PulseAudio is available — auto-install + auto-start if needed.
 */
function checkPulseAudio() {
  if (pulseAudioAvailable !== null) return pulseAudioAvailable;

  // Try auto-install if not present
  const installed = autoInstallPulseAudio();
  if (!installed) {
    pulseAudioAvailable = false;
    console.log("[MeetingTTS] No PulseAudio — Web Audio fallback (participants may not hear bot)");
    return false;
  }

  // Ensure daemon is running
  const running = ensurePulseAudioRunning();
  if (!running) {
    pulseAudioAvailable = false;
    return false;
  }

  pulseAudioAvailable = true;
  console.log("[MeetingTTS] PulseAudio ready — participants WILL hear the bot speak");
  return true;
}

/**
 * Set up PulseAudio virtual devices (one-time).
 * Creates tts_sink → virtual_mic pipeline.
 */
function setupPulseAudioDevices() {
  if (pulseAudioSetup) return true;
  try {
    // Create a null sink for TTS output
    execSync("pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description=DaemoraTTS", {
      stdio: "ignore", timeout: 5000,
    });

    // Remap the monitor of tts_sink as a source (virtual microphone)
    execSync("pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic source_properties=device.description=DaemoraMic", {
      stdio: "ignore", timeout: 5000,
    });

    // Set virtual_mic as default source so Chromium picks it up
    execSync("pactl set-default-source virtual_mic", {
      stdio: "ignore", timeout: 5000,
    });

    pulseAudioSetup = true;
    console.log("[MeetingTTS] PulseAudio virtual devices created (tts_sink → virtual_mic)");
    return true;
  } catch (e) {
    console.log(`[MeetingTTS] PulseAudio device setup failed: ${e.message}`);
    return false;
  }
}

/**
 * Speak in a meeting — generates TTS and routes through PulseAudio or Web Audio.
 *
 * @param {string} sessionId
 * @param {string} text
 * @param {object} session — raw session from MeetingSessionManager
 * @param {Function} getActivePage — returns Playwright page
 * @returns {Promise<string>}
 */
export async function meetingSpeak(sessionId, text, session, getActivePage) {
  // Generate TTS audio
  const ttsOpts = {
    text,
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
  const audioPath = pathMatch[1];

  // Try PulseAudio first (participants CAN hear)
  if (checkPulseAudio() && setupPulseAudioDevices()) {
    try {
      await playViaPulseAudio(audioPath);
      addTranscript(sessionId, { speaker: session.displayName, text });
      return `Spoke: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
    } catch (e) {
      console.log(`[MeetingTTS] PulseAudio playback failed: ${e.message}, falling back to Web Audio`);
    }
  }

  // Fallback: Web Audio injection (participants may NOT hear)
  const page = getActivePage();
  if (!page) return "Error: no browser page active";

  try {
    const audioBuffer = readFileSync(audioPath);
    const base64 = audioBuffer.toString("base64");

    await page.evaluate((b64) => {
      return new Promise(async (resolve) => {
        try {
          const ctx = window.__daemoraCaptureCtx || new AudioContext();
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const buf = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = buf;
          source.connect(ctx.destination);

          // Also try replaceTrack on any PeerConnection
          const pcs = window.__daemoraPeerConnections || [];
          const dest = ctx.createMediaStreamDestination();
          source.connect(dest);
          const ttsTrack = dest.stream.getAudioTracks()[0];
          const originals = [];

          for (const pc of pcs) {
            try {
              for (const sender of pc.getSenders()) {
                if (sender.track?.kind === "audio") {
                  originals.push({ sender, track: sender.track });
                  await sender.replaceTrack(ttsTrack);
                }
              }
            } catch {}
          }

          source.start();
          source.onended = async () => {
            for (const { sender, track } of originals) {
              try { await sender.replaceTrack(track); } catch {}
            }
            resolve("played");
          };
          setTimeout(() => resolve("timeout"), (buf.duration + 2) * 1000);
        } catch (e) {
          resolve("error: " + e.message);
        }
      });
    }, base64);

    addTranscript(sessionId, { speaker: session.displayName, text });
    return `Spoke: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
  } catch (e) {
    return `Audio injection failed: ${e.message}`;
  }
}

/**
 * Play audio through PulseAudio tts_sink using paplay/ffplay.
 * The audio goes: tts_sink → tts_sink.monitor → virtual_mic → Chromium → WebRTC → participants.
 */
function playViaPulseAudio(audioPath) {
  return new Promise((resolve, reject) => {
    // Use ffplay to decode any format and output to PulseAudio
    const proc = spawn("ffplay", [
      "-nodisp", "-autoexit",
      "-f", "pulse", "-device", "tts_sink",
      audioPath,
    ], { stdio: "ignore" });

    // Fallback: try paplay directly (works for WAV)
    proc.on("error", () => {
      const paplay = spawn("paplay", [
        "--device=tts_sink",
        audioPath,
      ], { stdio: "ignore" });

      paplay.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`paplay exit code ${code}`));
      });
      paplay.on("error", (e) => reject(e));
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffplay exit code ${code}`));
    });

    // Timeout — don't hang forever
    setTimeout(() => {
      proc.kill();
      reject(new Error("playback timeout"));
    }, 30000);
  });
}
