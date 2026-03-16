/**
 * Meeting Bot Docker Server — autonomous AI meeting participant.
 *
 * Runs INSIDE Docker container. Fully self-contained:
 * - Joins meeting via Playwright + stealth
 * - Captures audio → STT (Groq/OpenAI/local)
 * - VAD detects when user stops talking
 * - Auto-calls LLM for response → TTS → PulseAudio → participants hear
 * - No external agent needed for conversation — bot is autonomous
 *
 * HTTP API for host Daemora:
 *   POST /join    — join meeting
 *   POST /speak   — manual speak override
 *   POST /leave   — leave meeting
 *   GET  /listen  — get transcript
 *   GET  /status  — session state
 *   GET  /health  — container health
 */

import http from "node:http";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { execSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Stealth plugin ──────────────────────────────────────────────────────
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("iframe.contentWindow");
stealth.enabledEvasions.delete("media.codecs");
chromium.use(stealth);

// ── State ───────────────────────────────────────────────────────────────
let browser = null, context = null, page = null;
let session = null;
let transcript = [];
let captureActive = false;
let isSpeaking = false; // prevents auto-respond while bot is talking

const STORAGE = "/app/storage";
mkdirSync(join(STORAGE, "recordings"), { recursive: true });

// ── VAD state ───────────────────────────────────────────────────────────
let lastSpeechTime = 0;          // timestamp of last detected speech
let pendingResponse = false;     // waiting for silence to respond
const SILENCE_THRESHOLD_MS = 2000; // 2s silence = user stopped talking
const MIN_NEW_WORDS = 3;         // need at least 3 new words to trigger response
let lastRespondedIndex = 0;      // transcript index we last responded to

// ── Config from env ─────────────────────────────────────────────────────
const LLM_MODEL = process.env.LLM_MODEL || "openai:o4-mini";
const BOT_NAME = process.env.BOT_NAME || "Daemora";

// Parse LLM provider from model string (e.g. "openai:o4-mini" → openai)
function getLLMConfig() {
  const [provider, model] = LLM_MODEL.includes(":") ? LLM_MODEL.split(":", 2) : ["openai", LLM_MODEL];
  let baseURL, apiKey;

  if (provider === "groq") {
    baseURL = "https://api.groq.com/openai/v1";
    apiKey = process.env.GROQ_API_KEY;
  } else if (provider === "openai") {
    baseURL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
    apiKey = process.env.OPENAI_API_KEY;
  } else if (provider === "deepseek") {
    baseURL = "https://api.deepseek.com/v1";
    apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY;
  } else if (provider === "xai") {
    baseURL = "https://api.x.ai/v1";
    apiKey = process.env.XAI_API_KEY || process.env.LLM_API_KEY;
  } else if (provider === "openrouter") {
    baseURL = "https://openrouter.ai/api/v1";
    apiKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  } else {
    baseURL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
    apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  }

  return { provider, model, baseURL, apiKey };
}

// ── System prompt for autonomous meeting bot ────────────────────────────
const SYSTEM_PROMPT = `You are ${BOT_NAME} — an AI meeting participant. You are in a live meeting.

Rules:
- Respond in 1-2 sentences MAX. Talk like a real person in a meeting.
- If someone asks you a question → answer directly.
- If someone says your name → respond.
- If it's small talk or greetings → respond naturally ("Hey!", "Sounds good", "Got it").
- If nobody addressed you → respond with "" (empty string, stay silent).
- If the conversation doesn't need your input → respond with "".
- NEVER give long explanations. NEVER lecture. Keep it conversational.
- You can hear everything. You are a participant, not a recorder.

Examples:
- "Can you hear me?" → "Yeah, I can hear you clearly."
- "What do you think about the timeline?" → "I think two weeks is tight but doable."
- "Let's move on to the next topic" → ""
- "Daemora, take note of this" → "Got it, noted."
- Random chatter not directed at you → ""`;

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

// ── Audio capture script (from native services) ────────────────────────
const captureFile = readFileSync(join(import.meta.dirname, "../services/AudioCapture.js"), "utf-8");
const AUDIO_CAPTURE_SCRIPT = captureFile.match(/export const AUDIO_CAPTURE_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
const RTC_HOOK_SCRIPT = captureFile.match(/export const RTC_HOOK_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

// Speaker detection from googlemeet.js
const meetFile = readFileSync(join(import.meta.dirname, "../platforms/googlemeet.js"), "utf-8");
const SPEAKER_DETECTION_SCRIPT = meetFile.match(/export const SPEAKER_DETECTION_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

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
      json(res, await joinMeeting(await readBody(req)));
      return;
    }
    if (path === "/speak" && req.method === "POST") {
      const body = await readBody(req);
      json(res, { result: await speak(body.text) });
      return;
    }
    if (path === "/leave" && req.method === "POST") {
      json(res, { result: await leaveMeeting() });
      return;
    }
    if (path === "/listen" || path === "/transcript") {
      const last = parseInt(url.searchParams.get("last") || "30");
      json(res, { transcript: transcript.slice(-last), count: transcript.length });
      return;
    }
    if (path === "/status") {
      json(res, { state: session?.state || "idle", transcriptCount: transcript.length, captureActive, isSpeaking });
      return;
    }
    res.writeHead(404); res.end('{"error":"not found"}');
  } catch (e) {
    console.error(`[Server] ${e.message}`);
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = parseInt(process.env.PORT || "3456");
server.listen(PORT, "0.0.0.0", () => console.log(`[MeetingBot] Ready on :${PORT}`));

// ── Join Meeting ────────────────────────────────────────────────────────
async function joinMeeting(opts) {
  const { url, displayName = BOT_NAME, platform = "meet" } = opts;
  if (!url) throw new Error("url required");

  session = { state: "joining", platform, url, displayName };
  transcript = [];
  lastRespondedIndex = 0;

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

  // Start services
  await startAudioCapture();
  startAutoRespond();

  console.log(`[MeetingBot] Joined ${platform}: ${url}`);
  return { status: "joined", platform, sessionId: "docker" };
}

// ── Audio Capture + STT ─────────────────────────────────────────────────
let audioBuffer = [];
let sttTimer = null;
const STT_FLUSH_MS = 1500; // 1.5s batches for faster response
const STT_SAMPLE_RATE = 16000;
let currentSpeaker = "participant";

async function startAudioCapture() {
  if (!page) return;

  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      try {
        const arr = JSON.parse(jsonChunk);
        audioBuffer.push(new Float32Array(arr));
      } catch {}
    });
  } catch {}

  // Speaker detection callback
  try {
    await page.exposeFunction("__daemoraSpeakerChanged", (name) => {
      if (name && name !== currentSpeaker) {
        currentSpeaker = name;
      }
    });
  } catch {}

  await page.evaluate(AUDIO_CAPTURE_SCRIPT);
  captureActive = true;

  // Inject speaker detection
  if (SPEAKER_DETECTION_SCRIPT) {
    await page.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});
  }

  // STT flush loop
  sttTimer = setInterval(() => flushSTT(), STT_FLUSH_MS);
  console.log(`[MeetingBot] STT active (model: ${process.env.STT_MODEL || "whisper-large-v3-turbo"}, ${STT_FLUSH_MS}ms)`);
}

async function flushSTT() {
  if (audioBuffer.length === 0) return;
  const chunks = audioBuffer.splice(0);

  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(totalLen);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  if (merged.length < STT_SAMPLE_RATE * 0.3) return; // skip < 0.3s

  const wavBuf = float32ToWav(merged);

  try {
    const text = await transcribeAudio(wavBuf);
    if (text?.trim()?.length > 1) {
      const last = transcript[transcript.length - 1];
      if (!last || last.text !== text.trim()) {
        const speaker = (currentSpeaker || "participant").replace(/[\n\r]+/g, " ").trim();
        transcript.push({ speaker, text: text.trim(), timestamp: Date.now() });
        lastSpeechTime = Date.now();
        pendingResponse = true;
        console.log(`[STT] [${speaker}] "${text.trim().slice(0, 80)}"`);
      }
    }
  } catch (e) {
    console.log(`[STT] Error: ${e.message}`);
  }
}

async function transcribeAudio(wavBuf) {
  const sttModel = process.env.STT_MODEL || "whisper-large-v3-turbo";
  const isOpenaiStt = sttModel.includes("gpt-4o") || sttModel === "whisper-1";

  // Primary provider based on model
  if (isOpenaiStt && process.env.OPENAI_API_KEY) {
    return sttAPI("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, sttModel, wavBuf);
  }
  if (!isOpenaiStt && process.env.GROQ_API_KEY) {
    return sttAPI("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, sttModel, wavBuf);
  }
  // Fallbacks
  if (process.env.GROQ_API_KEY) {
    return sttAPI("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, "whisper-large-v3-turbo", wavBuf);
  }
  if (process.env.OPENAI_API_KEY) {
    return sttAPI("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, "whisper-1", wavBuf);
  }
  return null;
}

async function sttAPI(url, apiKey, model, wavBuf) {
  const fd = new FormData();
  fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "a.wav");
  fd.append("model", model);
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: fd });
  if (!r.ok) { console.log(`[STT] ${r.status}: ${await r.text().catch(() => "")}`); return null; }
  return (await r.json()).text;
}

// ── Auto-Respond Loop ───────────────────────────────────────────────────
let autoRespondTimer = null;

function startAutoRespond() {
  const llm = getLLMConfig();
  if (!llm.apiKey) {
    console.log("[MeetingBot] No LLM API key — auto-respond disabled");
    return;
  }
  console.log(`[MeetingBot] Auto-respond active (${llm.provider}:${llm.model})`);

  autoRespondTimer = setInterval(async () => {
    if (!session || session.state !== "active") return;
    if (isSpeaking) return;
    if (!pendingResponse) return;

    // Wait for silence (user stopped talking)
    const silenceMs = Date.now() - lastSpeechTime;
    if (silenceMs < SILENCE_THRESHOLD_MS) return;

    // Check if there's enough new content to respond to
    const newEntries = transcript.slice(lastRespondedIndex).filter(e => e.speaker !== BOT_NAME);
    if (newEntries.length === 0) { pendingResponse = false; return; }

    const newWords = newEntries.reduce((sum, e) => sum + e.text.split(/\s+/).length, 0);
    if (newWords < MIN_NEW_WORDS) { pendingResponse = false; return; }

    pendingResponse = false;
    lastRespondedIndex = transcript.length;

    // Build context — last 20 transcript entries
    const recentTranscript = transcript.slice(-20).map(e =>
      `[${e.speaker}]: ${e.text}`
    ).join("\n");

    try {
      const response = await callLLM(recentTranscript);
      if (response && response.trim() && response.trim() !== '""' && response.trim() !== "''") {
        const clean = response.replace(/^["']|["']$/g, "").trim();
        if (clean.length > 0 && clean.length < 200) {
          console.log(`[AutoRespond] "${clean}"`);
          await speak(clean);
        }
      }
    } catch (e) {
      console.log(`[AutoRespond] Error: ${e.message}`);
    }
  }, 500); // check every 500ms
}

async function callLLM(recentTranscript) {
  const llm = getLLMConfig();
  if (!llm.apiKey) return null;

  console.log(`[LLM] Calling ${llm.provider}:${llm.model} (${llm.baseURL})`);
  const r = await fetch(`${llm.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Recent meeting transcript:\n${recentTranscript}\n\nRespond naturally if someone needs your input, or respond with empty string "" if you should stay silent.` },
      ],
      max_completion_tokens: 150,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!r.ok) {
    console.log(`[LLM] ${r.status}: ${await r.text().catch(() => "")}`);
    return null;
  }

  const data = await r.json();
  return data.choices?.[0]?.message?.content || null;
}

// ── TTS / Speak ─────────────────────────────────────────────────────────
async function speak(text) {
  if (!text) return "Error: text required";
  if (!session || session.state !== "active") return "Error: not in meeting";
  if (isSpeaking) return "Already speaking";

  isSpeaking = true;

  try {
    const ttsModel = process.env.TTS_MODEL || "tts-1";
    const audioPath = join(STORAGE, "recordings", `tts-${Date.now()}.mp3`);

    const isGroq = ttsModel === "groq" || ttsModel.includes("orpheus");
    let playPath = audioPath;
    let ttsOk = false;

    // Try configured provider first
    if (isGroq && process.env.GROQ_API_KEY) {
      ttsOk = await ttsAPI(
        "https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY,
        "canopylabs/orpheus-v1-english", text, "hannah", "wav",
        audioPath.replace(".mp3", ".wav")
      );
      if (ttsOk) playPath = audioPath.replace(".mp3", ".wav");
    }

    if (!ttsOk && !isGroq && process.env.OPENAI_API_KEY) {
      ttsOk = await ttsAPI(
        "https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY,
        ttsModel, text, "nova", "mp3", audioPath
      );
    }

    // Fallbacks
    if (!ttsOk && process.env.GROQ_API_KEY) {
      playPath = audioPath.replace(".mp3", ".wav");
      ttsOk = await ttsAPI(
        "https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY,
        "canopylabs/orpheus-v1-english", text, "hannah", "wav", playPath
      );
    }
    if (!ttsOk && process.env.OPENAI_API_KEY) {
      playPath = audioPath;
      ttsOk = await ttsAPI(
        "https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY,
        "tts-1", text, "nova", "mp3", playPath
      );
    }

    if (!ttsOk) {
      isSpeaking = false;
      return "TTS error: no working provider";
    }

    // Unmute mic if needed
    try {
      await page.evaluate(() => {
        for (const btn of document.querySelectorAll("button")) {
          const l = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (l.includes("turn on microphone") || l.includes("unmute")) { btn.click(); return; }
        }
      });
      await page.waitForTimeout(300);
    } catch {}

    // Play through PulseAudio
    await playViaPulseAudio(playPath);
    transcript.push({ speaker: BOT_NAME, text, timestamp: Date.now() });
    lastRespondedIndex = transcript.length;

    return `Spoke: "${text.slice(0, 80)}"`;
  } catch (e) {
    return `Speak error: ${e.message}`;
  } finally {
    isSpeaking = false;
  }
}

async function ttsAPI(url, apiKey, model, text, voice, format, outPath) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text, voice, response_format: format }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.log(`[TTS] ${r.status}`); return false; }
    writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch (e) { console.log(`[TTS] ${e.message}`); return false; }
}

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

// ── WAV encoder ─────────────────────────────────────────────────────────
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

// ── Leave Meeting ───────────────────────────────────────────────────────
async function leaveMeeting() {
  if (autoRespondTimer) { clearInterval(autoRespondTimer); autoRespondTimer = null; }
  if (sttTimer) { clearInterval(sttTimer); sttTimer = null; }

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

// ── Graceful shutdown ───────────────────────────────────────────────────
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => { await leaveMeeting(); process.exit(0); });
}
