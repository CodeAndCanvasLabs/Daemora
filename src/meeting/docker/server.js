/**
 * Meeting Bot Docker Server — runs INSIDE the Docker container.
 *
 * Exposes HTTP API for host Daemora to control:
 *   POST /join    — join a meeting
 *   POST /speak   — TTS → PulseAudio → participants hear
 *   POST /leave   — leave meeting
 *   GET  /listen  — get latest transcript
 *   GET  /status  — session state
 *   GET  /health  — container health check
 *
 * All Playwright + PulseAudio operations happen inside this container.
 * Transcripts flow back to host Daemora via this API.
 */

import http from "node:http";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { execSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── Stealth plugin ──────────────────────────────────────────────────────
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("iframe.contentWindow");
stealth.enabledEvasions.delete("media.codecs");
chromium.use(stealth);

// ── State ───────────────────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;
let session = null;
let transcript = [];
let recording = { path: null, stream: null, samples: 0 };
let captureActive = false;

const STORAGE = "/app/storage";
const SAMPLE_RATE = 16000;

// ── Browser args (Vexa-matching) ────────────────────────────────────────
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-infobars",
  "--disable-gpu",
  "--use-fake-ui-for-media-stream",
  "--use-file-for-fake-video-capture=/dev/null",
  "--allow-running-insecure-content",
  "--disable-web-security",
  "--disable-site-isolation-trials",
  "--autoplay-policy=no-user-gesture-required",
  "--ignore-certificate-errors",
  "--ignore-certificate-errors-spki-list",
  "--disable-features=IsolateOrigins,site-per-process,CertificateTransparencyComponentUpdater",
];

// ── Audio capture script ────────────────────────────────────────────────
const AUDIO_CAPTURE_SCRIPT = readFileSync(
  join(import.meta.dirname, "../services/AudioCapture.js"), "utf-8"
).match(/export const AUDIO_CAPTURE_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

const RTC_HOOK_SCRIPT = readFileSync(
  join(import.meta.dirname, "../services/AudioCapture.js"), "utf-8"
).match(/export const RTC_HOOK_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    if (path === "/health") {
      json(res, { status: "ok", session: session?.state || "idle", transcriptCount: transcript.length });
      return;
    }

    if (path === "/join" && req.method === "POST") {
      const body = await readBody(req);
      const result = await joinMeeting(body);
      json(res, result);
      return;
    }

    if (path === "/speak" && req.method === "POST") {
      const body = await readBody(req);
      const result = await speak(body.text, body);
      json(res, { result });
      return;
    }

    if (path === "/leave" && req.method === "POST") {
      const result = await leaveMeeting();
      json(res, { result });
      return;
    }

    if (path === "/listen") {
      const last = parseInt(url.searchParams.get("last") || "30");
      const entries = transcript.slice(-last);
      json(res, { transcript: entries, count: transcript.length });
      return;
    }

    if (path === "/status") {
      json(res, {
        state: session?.state || "idle",
        platform: session?.platform || null,
        transcriptCount: transcript.length,
        captureActive,
        recording: recording.path,
      });
      return;
    }

    if (path === "/transcript") {
      const last = parseInt(url.searchParams.get("last") || "1000");
      json(res, { transcript: transcript.slice(-last) });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    console.error(`[Server] Error: ${e.message}`);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = parseInt(process.env.PORT || "3456");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[MeetingBot:Docker] Server ready on port ${PORT}`);
});

// ── Join Meeting ────────────────────────────────────────────────────────
async function joinMeeting(opts) {
  const { url, displayName = "Daemora", platform = "meet" } = opts;
  if (!url) throw new Error("url required");

  session = { state: "joining", platform, url, displayName };
  transcript = [];

  // Launch browser
  browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
  context = await browser.newContext({
    permissions: ["microphone", "camera"],
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  page = await context.newPage();

  // RTC hook before navigation
  await page.addInitScript(RTC_HOOK_SCRIPT);

  // Navigate
  const cleanUrl = url.replace(/[?&]authuser=\d+/, "").replace(/\?$/, "");
  await page.goto(cleanUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dismiss popups
  for (const sel of ['button:has-text("Got it")', 'button:has-text("OK")', 'button:has-text("Dismiss")']) {
    try { const btn = await page.$(sel); if (btn) await btn.click(); await page.waitForTimeout(300); } catch {}
  }

  // Fill name
  for (const sel of ['input[type="text"][aria-label="Your name"]', 'input[placeholder*="name" i]']) {
    try { const el = await page.$(sel); if (el) { await el.fill(displayName); break; } } catch {}
  }
  await page.waitForTimeout(500);

  // Camera off
  for (const sel of ['[aria-label*="Turn off camera" i]', 'button[aria-label*="camera" i]']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); break; } } catch {}
  }

  // Keep mic ON — PulseAudio virtual_mic needs it for TTS to reach meeting
  // Vexa also keeps mic on when voiceAgentEnabled=true
  await page.waitForTimeout(500);

  // Join
  let joined = false;
  for (const sel of ['button:has-text("Ask to join")', 'button:has-text("Join now")', 'button:has-text("Join")']) {
    try { const btn = await page.waitForSelector(sel, { timeout: 5000 }); if (btn) { await btn.click(); joined = true; break; } } catch {}
  }

  await page.waitForTimeout(8000);
  session.state = "active";

  // Start audio capture
  await startAudioCapture();

  console.log(`[MeetingBot:Docker] Joined ${platform} meeting: ${url}`);
  return { status: "joined", platform, sessionId: "docker" };
}

// ── Audio Capture + Transcription ────────────────────────────────────────
let audioBuffer = [];
let sttTimer = null;
const STT_FLUSH_MS = 3000;
const STT_SAMPLE_RATE = 16000;

async function startAudioCapture() {
  if (!page) return;

  // Expose callback — receives Float32 audio chunks from browser
  let chunkCount = 0;
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      try {
        const arr = JSON.parse(jsonChunk);
        audioBuffer.push(new Float32Array(arr));
        chunkCount++;
        if (chunkCount % 50 === 1) console.log(`[Audio] Chunk #${chunkCount} received (${arr.length} samples, buffer: ${audioBuffer.length})`);
      } catch {}
    });
  } catch {}

  // AUDIO_CAPTURE_SCRIPT is already a self-contained IIFE — inject it directly
  // Do NOT wrap in another IIFE that sets __daemoraCaptureActive (kills the script)
  await page.evaluate(AUDIO_CAPTURE_SCRIPT);

  captureActive = true;
  console.log("[MeetingBot:Docker] Audio capture started");

  // Start STT flush loop — API keys or local Whisper
  const apiKey = process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;
  let localPipeline = null;

  sttTimer = setInterval(async () => {
    if (audioBuffer.length === 0) return;
    const chunks = audioBuffer.splice(0);

    // Merge chunks
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(totalLen);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }

    if (merged.length < STT_SAMPLE_RATE * 0.5) return; // skip < 0.5s

    // Convert to WAV
    const wavBuf = float32ToWav(merged);

    try {
      let text = null;
      const sttModel = process.env.STT_MODEL || "whisper-large-v3-turbo";

      // Use configured STT model — detect provider from model name
      const useGroq = sttModel.includes("whisper") || !process.env.OPENAI_API_KEY;

      if (useGroq && process.env.GROQ_API_KEY) {
        const fd = new FormData();
        fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "a.wav");
        fd.append("model", sttModel.includes("gpt-4o") ? "whisper-large-v3-turbo" : sttModel);
        const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: fd,
        });
        if (r.ok) text = (await r.json()).text;
        else console.log(`[STT] Groq error: ${r.status} ${await r.text().catch(() => "")}`);
      } else if (process.env.OPENAI_API_KEY) {
        const fd = new FormData();
        fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "a.wav");
        fd.append("model", sttModel);
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: fd,
        });
        if (r.ok) text = (await r.json()).text;
        else console.log(`[STT] OpenAI error: ${r.status} ${await r.text().catch(() => "")}`);
      } else {
        // Local Whisper fallback (free, no API key)
        if (!localPipeline) {
          try {
            console.log("[STT] Loading local Whisper model (~75MB)...");
            const { pipeline } = await import("@huggingface/transformers");
            localPipeline = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", { device: "cpu" });
            console.log("[STT] Local Whisper loaded");
          } catch (e) {
            console.log(`[STT] Local Whisper failed: ${e.message}`);
            return;
          }
        }
        try {
          const pcm = new Int16Array(wavBuf.buffer, wavBuf.byteOffset + 44, (wavBuf.length - 44) / 2);
          const f32 = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768.0;
          const result = await localPipeline(f32, { sampling_rate: STT_SAMPLE_RATE, language: "en", task: "transcribe" });
          text = result?.text || null;
        } catch (e) {
          console.log(`[STT] Local error: ${e.message}`);
        }
      }

      if (text?.trim()?.length > 1) {
        // Dedup
        const last = transcript[transcript.length - 1];
        if (!last || last.text !== text.trim()) {
          transcript.push({ speaker: "participant", text: text.trim(), timestamp: Date.now() });
          console.log(`[STT] "${text.trim().slice(0, 80)}"`);
        }
      }
    } catch (e) {
      console.log(`[STT] Error: ${e.message}`);
    }
  }, STT_FLUSH_MS);

  console.log(`[MeetingBot:Docker] STT active (${process.env.OPENAI_API_KEY ? "OpenAI" : "Groq"}, ${STT_FLUSH_MS/1000}s flush)`);
}

function float32ToWav(f32) {
  const ds = f32.length * 2;
  const buf = Buffer.alloc(44 + ds);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + ds, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(STT_SAMPLE_RATE, 24);
  buf.writeUInt32LE(STT_SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(ds, 40);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2);
  }
  return buf;
}

// ── TTS / Speak ─────────────────────────────────────────────────────────
async function speak(text, opts = {}) {
  if (!text) return "Error: text required";
  if (!session || session.state !== "active") return "Error: not in meeting";

  // Generate TTS audio file
  const audioPath = join(STORAGE, "recordings", `tts-${Date.now()}.mp3`);
  const apiKey = opts.openaiKey || process.env.OPENAI_API_KEY;

  let ttsOk = false;

  if (apiKey) {
    // OpenAI TTS
    const model = opts.model || process.env.TTS_MODEL || "gpt-4o-mini-tts";
    const voice = opts.voice || "nova";
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    });
    if (res.ok) {
      writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
      ttsOk = true;
    } else {
      console.log(`[TTS] OpenAI failed (${res.status}), trying fallback...`);
    }
  }

  if (!ttsOk && process.env.GROQ_API_KEY) {
    // Groq TTS
    const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "canopylabs/orpheus-v1-english", input: text, voice: opts.voice || "hannah", response_format: "wav" }),
    });
    if (!res.ok) return `TTS error: Groq ${res.status}`;
    const wavPath = audioPath.replace(".mp3", ".wav");
    writeFileSync(wavPath, Buffer.from(await res.arrayBuffer()));
    // Play WAV directly
    try {
      await playViaPulseAudio(wavPath);
      transcript.push({ speaker: session.displayName || "Daemora", text, timestamp: Date.now() });
      return `Spoke: "${text.slice(0, 80)}"`;
    } catch (e) {
      return `PulseAudio playback error: ${e.message}`;
    }
  }

  if (!ttsOk) {
    return "TTS error: no working provider (tried OpenAI + Groq)";
  }

  // Unmute mic before speaking (was muted during join)
  try {
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const btn of btns) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("turn on microphone") || label.includes("unmute")) {
          btn.click(); return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(500);
  } catch {}

  // Play through PulseAudio virtual mic → meeting participants hear it
  try {
    await playViaPulseAudio(audioPath);
    transcript.push({ speaker: session.displayName || "Daemora", text, timestamp: Date.now() });

    // Do NOT re-mute — mic must stay ON for PulseAudio virtual mic to work

    return `Spoke: "${text.slice(0, 80)}"`;
  } catch (e) {
    return `PulseAudio playback error: ${e.message}`;
  }
}

function playViaPulseAudio(audioPath) {
  return new Promise((resolve, reject) => {
    // ffplay outputs to PulseAudio tts_sink → virtual_mic → Chromium → WebRTC
    const proc = spawn("ffplay", [
      "-nodisp", "-autoexit", "-af", "aresample=24000",
      audioPath,
    ], {
      stdio: "ignore",
      env: { ...process.env, PULSE_SINK: "tts_sink" },
    });

    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffplay exit ${code}`)));
    proc.on("error", () => {
      // Fallback: paplay
      const pa = spawn("paplay", ["--device=tts_sink", audioPath], { stdio: "ignore" });
      pa.on("close", (c) => c === 0 ? resolve() : reject(new Error(`paplay exit ${c}`)));
      pa.on("error", reject);
    });

    setTimeout(() => { proc.kill(); reject(new Error("playback timeout")); }, 30000);
  });
}

// ── Leave Meeting ───────────────────────────────────────────────────────
async function leaveMeeting() {
  if (!page) return "Not in meeting";

  // Click leave button
  for (const sel of ['[aria-label*="Leave" i]', 'button:has-text("Leave")', '[data-tooltip*="Leave" i]']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); break; } } catch {}
  }

  await page.waitForTimeout(2000);

  // Close browser
  try { await browser.close(); } catch {}
  browser = null; context = null; page = null;
  session = { ...session, state: "left" };
  captureActive = false;

  console.log(`[MeetingBot:Docker] Left meeting. ${transcript.length} transcript entries.`);
  return `Left meeting. ${transcript.length} entries captured.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function json(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// ── Graceful shutdown ───────────────────────────────────────────────────
process.on("SIGTERM", async () => {
  console.log("[MeetingBot:Docker] SIGTERM — leaving meeting...");
  await leaveMeeting();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[MeetingBot:Docker] SIGINT — leaving meeting...");
  await leaveMeeting();
  process.exit(0);
});
