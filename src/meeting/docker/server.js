/**
 * Meeting Bot Docker Server — audio infrastructure for meeting participation.
 *
 * Handles ONLY: browser joining, audio capture, STT (→ transcript), TTS (← speak), PulseAudio.
 * LLM reasoning lives OUTSIDE Docker in the Daemora meeting-attendant agent, which polls
 * /transcript/new?since=N and calls /speak when it wants to respond.
 *
 * STT modes (auto-selected):
 * 1. REALTIME — OpenAI Realtime API WebSocket, semantic VAD, low-latency STT only
 * 2. PIPELINE — Deepgram WebSocket STT → transcript
 * 3. BATCH    — Groq/OpenAI batch transcription fallback
 *
 * Mode: MEETING_MODE env (realtime|pipeline|auto)
 * - auto: realtime if OPENAI_API_KEY set, pipeline if DEEPGRAM_API_KEY, else batch
 *
 * HTTP API (polled by Daemora agent):
 *   POST /join                    — join meeting
 *   POST /speak                   — TTS → PulseAudio → meeting mic
 *   POST /leave                   — leave + cleanup
 *   GET  /transcript/new?since=N  — entries from index N (agent polling loop)
 *   GET  /listen?last=N           — last N entries (legacy)
 *   GET  /status                  — session state
 *   GET  /health                  — health check
 */

import http from "node:http";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Stealth ─────────────────────────────────────────────────────────────
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("iframe.contentWindow");
stealth.enabledEvasions.delete("media.codecs");
chromium.use(stealth);

// ── State ───────────────────────────────────────────────────────────────
let browser = null, context = null, page = null;
let session = null;
let transcript = [];
let captureActive = false;
let isSpeaking = false;
let activeMode = null; // "realtime" | "pipeline"

const STORAGE = "/app/storage";
mkdirSync(join(STORAGE, "recordings"), { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────
const BOT_NAME = process.env.BOT_NAME || "Daemora";
const MEETING_MODE = process.env.MEETING_MODE || "auto";

// ── Audio scripts (from native services) ────────────────────────────────
const captureFile = readFileSync(join(import.meta.dirname, "../services/AudioCapture.js"), "utf-8");
const AUDIO_CAPTURE_SCRIPT = captureFile.match(/export const AUDIO_CAPTURE_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
const RTC_HOOK_SCRIPT = captureFile.match(/export const RTC_HOOK_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
const meetFile = readFileSync(join(import.meta.dirname, "../platforms/googlemeet.js"), "utf-8");
const SPEAKER_DETECTION_SCRIPT = meetFile.match(/export const SPEAKER_DETECTION_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

// ── Browser args ────────────────────────────────────────────────────────
const BROWSER_ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-infobars", "--disable-gpu",
  "--use-fake-ui-for-media-stream",
  "--use-file-for-fake-video-capture=/dev/null",
  "--allow-running-insecure-content", "--disable-web-security",
  "--autoplay-policy=no-user-gesture-required",
  "--ignore-certificate-errors",
];

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    if (path === "/health") return json(res, { status: "ok", mode: activeMode, session: session?.state || "idle", transcriptCount: transcript.length });
    if (path === "/join" && req.method === "POST") return json(res, await joinMeeting(await readBody(req)));
    if (path === "/speak" && req.method === "POST") { const b = await readBody(req); return json(res, { result: await speak(b.text) }); }
    if (path === "/leave" && req.method === "POST") return json(res, { result: await leaveMeeting() });
    // Index-based polling: returns transcript[since:] — agent tracks nextSince across calls
    if (path === "/transcript/new") {
      const since = Math.max(0, parseInt(url.searchParams.get("since") || "0"));
      const entries = transcript.slice(since);
      return json(res, { entries, total: transcript.length, nextSince: transcript.length });
    }
    // Legacy: last N entries
    if (path === "/listen" || path === "/transcript") {
      const last = parseInt(url.searchParams.get("last") || "30");
      return json(res, { transcript: transcript.slice(-last), count: transcript.length });
    }
    if (path === "/status") return json(res, { state: session?.state || "idle", mode: activeMode, transcriptCount: transcript.length, captureActive, isSpeaking });
    res.writeHead(404); res.end('{"error":"not found"}');
  } catch (e) {
    console.error(`[Server] ${e.message}`);
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(parseInt(process.env.PORT || "3456"), "0.0.0.0", () => console.log(`[MeetingBot] Ready on :${process.env.PORT || 3456}`));

// ══════════════════════════════════════════════════════════════════════════
// JOIN MEETING
// ══════════════════════════════════════════════════════════════════════════

async function joinMeeting(opts) {
  const { url, displayName = BOT_NAME, platform = "meet" } = opts;
  if (!url) throw new Error("url required");

  session = { state: "joining", platform, url, displayName };
  transcript = [];

  browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
  context = await browser.newContext({
    permissions: ["microphone", "camera"],
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    bypassCSP: true, ignoreHTTPSErrors: true,
  });

  page = await context.newPage();
  await page.addInitScript(RTC_HOOK_SCRIPT);

  const cleanUrl = url.replace(/[?&]authuser=\d+/, "").replace(/\?$/, "");
  await page.goto(cleanUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dismiss popups
  for (const sel of ['button:has-text("Got it")', 'button:has-text("OK")', 'button:has-text("Dismiss")', 'button:has-text("Accept all")']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); await page.waitForTimeout(300); } } catch {}
  }

  // Fill name
  for (const sel of ['input[type="text"][aria-label="Your name"]', 'input[placeholder*="name" i]']) {
    try { const el = await page.$(sel); if (el) { await el.fill(displayName); break; } } catch {}
  }
  await page.waitForTimeout(500);

  // Camera off
  for (const sel of ['[aria-label*="Turn off camera" i]']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); break; } } catch {}
  }
  await page.waitForTimeout(500);

  // Join
  for (const sel of ['button:has-text("Ask to join")', 'button:has-text("Join now")', 'button:has-text("Join")']) {
    try { const btn = await page.waitForSelector(sel, { timeout: 5000 }); if (btn) { await btn.click(); break; } } catch {}
  }

  await page.waitForTimeout(8000);
  session.state = "active";

  // Decide STT mode
  const useRealtime = MEETING_MODE === "realtime" ||
    (MEETING_MODE === "auto" && process.env.OPENAI_API_KEY && !process.env.DEEPGRAM_API_KEY);

  if (useRealtime && process.env.OPENAI_API_KEY) {
    activeMode = "realtime";
    await startRealtimeMode();
  } else {
    activeMode = "pipeline";
    await startPipelineMode();
  }

  console.log(`[MeetingBot] Joined ${platform} (${activeMode} STT): ${url}`);
  return { status: "joined", platform, mode: activeMode, sessionId: "docker" };
}

// ══════════════════════════════════════════════════════════════════════════
// MODE 1: OPENAI REALTIME API (STT only — no auto-response)
// Agent polls /transcript/new and decides when to speak via /speak
// ══════════════════════════════════════════════════════════════════════════

let realtimeWs = null;

async function startRealtimeMode() {
  // Expose audio callback — receives Float32 from browser, converts to PCM16 base64
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
      try {
        const f32 = new Float32Array(JSON.parse(jsonChunk));
        // Resample 16kHz → 24kHz (OpenAI Realtime expects 24kHz PCM16)
        const ratio = 24000 / 16000;
        const outLen = Math.round(f32.length * ratio);
        const resampled = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const srcIdx = i / ratio;
          const left = Math.floor(srcIdx);
          const right = Math.min(left + 1, f32.length - 1);
          const frac = srcIdx - left;
          resampled[i] = f32[left] + (f32[right] - f32[left]) * frac;
        }
        const pcm16 = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const s = Math.max(-1, Math.min(1, resampled[i]));
          pcm16[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF);
        }
        const b64 = Buffer.from(pcm16.buffer).toString("base64");
        realtimeWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      } catch {}
    });
  } catch {}

  // Speaker detection
  try {
    await page.exposeFunction("__daemoraSpeakerChanged", (name) => {
      if (name) currentSpeakerName = name.replace(/[\n\r]+/g, " ").trim();
    });
  } catch {}

  await page.evaluate(AUDIO_CAPTURE_SCRIPT);
  captureActive = true;
  if (SPEAKER_DETECTION_SCRIPT) await page.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});

  const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`;
  console.log(`[Realtime] Connecting to ${wsUrl}`);

  realtimeWs = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });

  realtimeWs.addEventListener("open", () => {
    console.log("[Realtime] Connected — STT only (agent handles responses outside Docker)");
    // STT only: create_response=false so OpenAI transcribes but doesn't auto-respond
    realtimeWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: { type: "pcm16", sample_rate: 24000 },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        // create_response: false — LLM reasoning outside Docker in Daemora agent
        turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: false },
      },
    }));
  });

  realtimeWs.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript?.trim()) {
        const speaker = currentSpeakerName || "participant";
        transcript.push({ speaker, text: msg.transcript.trim(), timestamp: Date.now() });
        console.log(`[Realtime:STT] [${speaker}] "${msg.transcript.trim().slice(0, 80)}"`);
      } else if (msg.type === "error") {
        console.log(`[Realtime:Error] ${JSON.stringify(msg.error)}`);
      }
    } catch {}
  });

  realtimeWs.addEventListener("close", () => { console.log("[Realtime] Disconnected"); realtimeWs = null; });
  realtimeWs.addEventListener("error", (e) => { console.log(`[Realtime] Error: ${e.message || "connection error"}`); });

  console.log("[Realtime] Mode active — STT streams to OpenAI, agent polls /transcript/new");
}

// ══════════════════════════════════════════════════════════════════════════
// MODE 2: STREAMING PIPELINE (STT only — agent handles LLM+responses)
// ══════════════════════════════════════════════════════════════════════════

let currentSpeakerName = "participant";
let sttWs = null;
let sttTimer = null;
let audioBuffer = [];
const STT_SAMPLE_RATE = 16000;

async function startPipelineMode() {
  // Audio callback
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      try {
        const f32 = new Float32Array(JSON.parse(jsonChunk));
        if (sttWs && sttWs.readyState === WebSocket.OPEN) {
          sttWs.send(float32ToPCM16(f32));
        } else {
          audioBuffer.push(f32);
        }
      } catch {}
    });
  } catch {}

  // Speaker detection
  try {
    await page.exposeFunction("__daemoraSpeakerChanged", (name) => {
      if (name) currentSpeakerName = name.replace(/[\n\r]+/g, " ").trim();
    });
  } catch {}

  await page.evaluate(AUDIO_CAPTURE_SCRIPT);
  captureActive = true;
  if (SPEAKER_DETECTION_SCRIPT) await page.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});

  if (process.env.DEEPGRAM_API_KEY) {
    await startDeepgramSTT();
  } else {
    sttTimer = setInterval(() => flushBatchSTT(), 1500);
    const provider = process.env.GROQ_API_KEY ? "Groq" : process.env.OPENAI_API_KEY ? "OpenAI" : "none";
    console.log(`[Pipeline] STT: batch (${provider}, 1.5s) — agent polls /transcript/new`);
  }
}

// ── Deepgram Streaming STT ──────────────────────────────────────────────

async function startDeepgramSTT() {
  const params = new URLSearchParams({
    model: "nova-3", smart_format: "true", punctuate: "true",
    diarize: "false", interim_results: "true", endpointing: "300",
    sample_rate: "16000", channels: "1", encoding: "linear16",
  });

  try {
    sttWs = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
      sttWs.addEventListener("open", () => { clearTimeout(timeout); resolve(); });
      sttWs.addEventListener("error", (e) => { clearTimeout(timeout); reject(e); });
    });

    sttWs.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (data.type !== "Results" || !data.is_final) return;
        const text = data.channel?.alternatives?.[0]?.transcript?.trim();
        if (!text || text.length < 2) return;
        const speaker = currentSpeakerName || "participant";
        const last = transcript[transcript.length - 1];
        if (!last || last.text !== text) {
          transcript.push({ speaker, text, timestamp: Date.now() });
          console.log(`[STT:Deepgram] [${speaker}] "${text.slice(0, 80)}"`);
        }
      } catch {}
    });

    sttWs.addEventListener("close", () => {
      console.log("[STT:Deepgram] Disconnected — falling back to batch");
      sttWs = null;
      if (session?.state === "active" && !sttTimer) {
        sttTimer = setInterval(() => flushBatchSTT(), 1500);
      }
    });

    console.log("[Pipeline] STT: Deepgram streaming (nova-3, ~200ms) — agent polls /transcript/new");
  } catch (e) {
    console.log(`[STT:Deepgram] Failed: ${e.message}, using batch fallback`);
    sttWs = null;
    sttTimer = setInterval(() => flushBatchSTT(), 1500);
  }
}

// ── Batch STT (fallback) ────────────────────────────────────────────────

async function flushBatchSTT() {
  if (audioBuffer.length === 0) return;
  const chunks = audioBuffer.splice(0);
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(totalLen);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  if (merged.length < STT_SAMPLE_RATE * 0.3) return;

  try {
    const text = await batchTranscribe(float32ToWav(merged));
    if (text?.trim()?.length > 1) {
      const last = transcript[transcript.length - 1];
      if (!last || last.text !== text.trim()) {
        const speaker = currentSpeakerName || "participant";
        transcript.push({ speaker, text: text.trim(), timestamp: Date.now() });
        console.log(`[STT:Batch] [${speaker}] "${text.trim().slice(0, 80)}"`);
      }
    }
  } catch (e) { console.log(`[STT] ${e.message}`); }
}

async function batchTranscribe(wavBuf) {
  const sttModel = process.env.STT_MODEL || "whisper-large-v3-turbo";
  const isOpenai = sttModel.includes("gpt-4o") || sttModel === "whisper-1";
  if (isOpenai && process.env.OPENAI_API_KEY) return sttAPI("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, sttModel, wavBuf);
  if (!isOpenai && process.env.GROQ_API_KEY) return sttAPI("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, sttModel, wavBuf);
  if (process.env.GROQ_API_KEY) return sttAPI("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, "whisper-large-v3-turbo", wavBuf);
  if (process.env.OPENAI_API_KEY) return sttAPI("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, "whisper-1", wavBuf);
  return null;
}

async function sttAPI(url, apiKey, model, wavBuf) {
  const fd = new FormData();
  fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "a.wav");
  fd.append("model", model);
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: fd });
  if (!r.ok) { console.log(`[STT] ${r.status}`); return null; }
  return (await r.json()).text;
}

// ══════════════════════════════════════════════════════════════════════════
// TTS / SPEAK — called by Daemora agent via POST /speak
// ══════════════════════════════════════════════════════════════════════════

async function speak(text) {
  if (!text || !session || session.state !== "active") return "Not in meeting";
  if (isSpeaking) return "Already speaking — try again in a moment";
  isSpeaking = true;

  try {
    const ttsModel = process.env.TTS_MODEL || "tts-1";
    const audioPath = join(STORAGE, "recordings", `tts-${Date.now()}.mp3`);
    const isGroq = ttsModel === "groq" || ttsModel.includes("orpheus");
    let playPath = audioPath;
    let ok = false;

    // Try configured provider first
    if (isGroq && process.env.GROQ_API_KEY) {
      playPath = audioPath.replace(".mp3", ".wav");
      ok = await ttsAPI_req("https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY, "canopylabs/orpheus-v1-english", text, "hannah", "wav", playPath);
    }
    if (!ok && !isGroq && process.env.OPENAI_API_KEY) {
      ok = await ttsAPI_req("https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY, ttsModel, text, "nova", "mp3", audioPath);
      playPath = audioPath;
    }
    // Fallbacks
    if (!ok && process.env.GROQ_API_KEY) {
      playPath = audioPath.replace(".mp3", ".wav");
      ok = await ttsAPI_req("https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY, "canopylabs/orpheus-v1-english", text, "hannah", "wav", playPath);
    }
    if (!ok && process.env.OPENAI_API_KEY) {
      playPath = audioPath;
      ok = await ttsAPI_req("https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY, "tts-1", text, "nova", "mp3", playPath);
    }

    if (!ok) return "TTS error: no working provider";

    // Unmute if needed
    try {
      await page.evaluate(() => {
        for (const btn of document.querySelectorAll("button")) {
          const l = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (l.includes("turn on microphone") || l.includes("unmute")) { btn.click(); return; }
        }
      });
      await page.waitForTimeout(300);
    } catch {}

    await playViaPulseAudio(playPath);
    transcript.push({ speaker: BOT_NAME, text, timestamp: Date.now() });
    return `Spoke: "${text.slice(0, 80)}"`;
  } catch (e) {
    return `Speak error: ${e.message}`;
  } finally {
    isSpeaking = false;
  }
}

async function ttsAPI_req(url, apiKey, model, text, voice, format, outPath) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text, voice, response_format: format }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.log(`[TTS] ${model}: ${r.status}`); return false; }
    writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch (e) { console.log(`[TTS] ${e.message}`); return false; }
}

// ══════════════════════════════════════════════════════════════════════════
// AUDIO UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function playViaPulseAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffplay", ["-nodisp", "-autoexit", "-af", "aresample=24000", audioPath], {
      stdio: "ignore", env: { ...process.env, PULSE_SINK: "tts_sink" },
    });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffplay exit ${code}`)));
    proc.on("error", () => {
      const pa = spawn("paplay", ["--device=tts_sink", audioPath], { stdio: "ignore" });
      pa.on("close", (c) => c === 0 ? resolve() : reject(new Error(`paplay exit ${c}`)));
      pa.on("error", reject);
    });
    setTimeout(() => { proc.kill(); reject(new Error("playback timeout")); }, 30000);
  });
}

function float32ToPCM16(f32) {
  const buf = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), i * 2);
  }
  return buf;
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

// ══════════════════════════════════════════════════════════════════════════
// LEAVE / CLEANUP
// ══════════════════════════════════════════════════════════════════════════

async function leaveMeeting() {
  if (sttTimer) { clearInterval(sttTimer); sttTimer = null; }
  if (sttWs) { try { sttWs.send(JSON.stringify({ type: "CloseStream" })); sttWs.close(); } catch {} sttWs = null; }
  if (realtimeWs) { try { realtimeWs.close(); } catch {} realtimeWs = null; }

  if (page) {
    for (const sel of ['[aria-label*="Leave" i]', 'button:has-text("Leave")']) {
      try { const btn = await page.$(sel); if (btn) { await btn.click(); break; } } catch {}
    }
    await page.waitForTimeout(2000);
  }

  try { await browser?.close(); } catch {}
  browser = null; context = null; page = null;
  session = { ...session, state: "left" };
  captureActive = false;

  console.log(`[MeetingBot] Left. ${transcript.length} transcript entries.`);
  return `Left meeting. ${transcript.length} entries.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function json(res, data) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => { await leaveMeeting(); process.exit(0); });
}
