/**
 * Meeting Bot Docker Server — streaming voice pipeline for meeting participation.
 *
 * Implements agents-js style concurrent streaming:
 *   Deepgram STT (WebSocket) → silence detection → LLM (SSE stream)
 *     → sentence splitter → TTS → PulseAudio (per-sentence, not batch)
 *
 * This means first audio out in ~300ms after user stops speaking, not 4-6s.
 *
 * Modes:
 * 1. REALTIME  — OpenAI Realtime API: single WebSocket, <1s, audio-in/audio-out
 * 2. PIPELINE  — Deepgram WS STT → streaming LLM → sentence TTS → PulseAudio
 * 3. BATCH     — fallback: 1.5s flush STT → LLM → TTS
 *
 * MEETING_MODE env: realtime | pipeline | auto (default)
 *   auto: realtime if OPENAI_API_KEY, pipeline if DEEPGRAM_API_KEY, else batch
 *
 * HTTP API:
 *   POST /join                    — join meeting
 *   POST /speak                   — manual TTS (agent-initiated speech)
 *   POST /leave                   — leave + cleanup
 *   GET  /transcript/new?since=N  — index-based polling (Daemora agent)
 *   GET  /listen?last=N           — last N entries
 *   GET  /status                  — session state
 *   GET  /health                  — health check
 */

import http from "node:http";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stealth = StealthPlugin();
stealth.enabledEvasions.delete("iframe.contentWindow");
stealth.enabledEvasions.delete("media.codecs");
chromium.use(stealth);

// ── State ────────────────────────────────────────────────────────────────
let browser = null, context = null, page = null;
let session = null;
let transcript = [];
let captureActive = false;
let isSpeaking = false;
let activeMode = null;

const STORAGE = "/app/storage";
mkdirSync(join(STORAGE, "recordings"), { recursive: true });

// ── Config ───────────────────────────────────────────────────────────────
const BOT_NAME = process.env.BOT_NAME || "Daemora";
const MEETING_MODE = process.env.MEETING_MODE || "auto";
const LLM_MODEL = process.env.LLM_MODEL || "openai:o4-mini";

// ── Audio scripts ────────────────────────────────────────────────────────
const captureFile = readFileSync(join(import.meta.dirname, "../services/AudioCapture.js"), "utf-8");
const AUDIO_CAPTURE_SCRIPT = captureFile.match(/export const AUDIO_CAPTURE_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
const RTC_HOOK_SCRIPT = captureFile.match(/export const RTC_HOOK_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
const meetFile = readFileSync(join(import.meta.dirname, "../platforms/googlemeet.js"), "utf-8");
const SPEAKER_DETECTION_SCRIPT = meetFile.match(/export const SPEAKER_DETECTION_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";

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

// ── HTTP Server ──────────────────────────────────────────────────────────
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
    if (path === "/transcript/new") {
      const since = Math.max(0, parseInt(url.searchParams.get("since") || "0"));
      return json(res, { entries: transcript.slice(since), total: transcript.length, nextSince: transcript.length });
    }
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

server.listen(parseInt(process.env.PORT || "3456"), "0.0.0.0", () =>
  console.log(`[MeetingBot] Ready on :${process.env.PORT || 3456}`)
);

// ══════════════════════════════════════════════════════════════════════════
// JOIN
// ══════════════════════════════════════════════════════════════════════════

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

  for (const sel of ['button:has-text("Got it")', 'button:has-text("OK")', 'button:has-text("Dismiss")', 'button:has-text("Accept all")']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); await page.waitForTimeout(300); } } catch {}
  }
  for (const sel of ['input[type="text"][aria-label="Your name"]', 'input[placeholder*="name" i]']) {
    try { const el = await page.$(sel); if (el) { await el.fill(displayName); break; } } catch {}
  }
  await page.waitForTimeout(500);
  for (const sel of ['[aria-label*="Turn off camera" i]']) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); break; } } catch {}
  }
  await page.waitForTimeout(500);
  for (const sel of ['button:has-text("Ask to join")', 'button:has-text("Join now")', 'button:has-text("Join")']) {
    try { const btn = await page.waitForSelector(sel, { timeout: 5000 }); if (btn) { await btn.click(); break; } } catch {}
  }

  await page.waitForTimeout(8000);
  session.state = "active";

  // Select mode
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
  const useRealtime = MEETING_MODE === "realtime" ||
    (MEETING_MODE === "auto" && hasOpenAI && !hasDeepgram);

  if (useRealtime && hasOpenAI) {
    activeMode = "realtime";
    await startRealtimeMode();
  } else {
    activeMode = "pipeline";
    await startPipelineMode();
  }

  console.log(`[MeetingBot] Joined ${platform} (mode: ${activeMode}): ${url}`);
  return { status: "joined", platform, mode: activeMode, sessionId: "docker" };
}

// ══════════════════════════════════════════════════════════════════════════
// MODE 1: OPENAI REALTIME API
// Full audio-in → audio-out pipeline in a single WebSocket. <1s latency.
// OpenAI handles STT + LLM + TTS — bot responds autonomously.
// ══════════════════════════════════════════════════════════════════════════

let realtimeWs = null;

async function startRealtimeMode() {
  try {
    await page.exposeFunction("__daemoraSendAudio", (jsonChunk) => {
      if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
      try {
        const f32 = new Float32Array(JSON.parse(jsonChunk));
        // Resample 16kHz → 24kHz
        const ratio = 24000 / 16000;
        const outLen = Math.round(f32.length * ratio);
        const resampled = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const src = i / ratio;
          const l = Math.floor(src), r = Math.min(l + 1, f32.length - 1);
          resampled[i] = f32[l] + (f32[r] - f32[l]) * (src - l);
        }
        const pcm16 = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const s = Math.max(-1, Math.min(1, resampled[i]));
          pcm16[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF);
        }
        realtimeWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16.buffer).toString("base64"),
        }));
      } catch {}
    });
  } catch {}

  try {
    await page.exposeFunction("__daemoraSpeakerChanged", (name) => {
      if (name) currentSpeakerName = name.replace(/[\n\r]+/g, " ").trim();
    });
  } catch {}

  await page.evaluate(AUDIO_CAPTURE_SCRIPT);
  captureActive = true;
  if (SPEAKER_DETECTION_SCRIPT) await page.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});

  const wsUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  realtimeWs = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });

  realtimeWs.addEventListener("open", () => {
    console.log("[Realtime] Connected — full audio pipeline active");
    realtimeWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: buildSystemPrompt(),
        voice: "coral",
        input_audio_format: { type: "pcm16", sample_rate: 24000 },
        output_audio_format: { type: "pcm16", sample_rate: 24000 },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,     // autonomous response
          interrupt_response: true,
        },
      },
    }));
  });

  let audioChunks = [];

  realtimeWs.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      switch (msg.type) {
        case "input_audio_buffer.speech_started":
          audioChunks = [];
          break;

        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript?.trim()) {
            const speaker = currentSpeakerName || "participant";
            transcript.push({ speaker, text: msg.transcript.trim(), timestamp: Date.now() });
            console.log(`[Realtime:STT] [${speaker}] "${msg.transcript.trim().slice(0, 80)}"`);
          }
          break;

        case "response.audio.delta":
        case "response.output_audio.delta":
          if (msg.delta) audioChunks.push(Buffer.from(msg.delta, "base64"));
          break;

        case "response.audio.done":
        case "response.output_audio.done":
          if (audioChunks.length > 0) {
            const audio = Buffer.concat(audioChunks);
            audioChunks = [];
            playPCM24k(audio).catch(e => console.log(`[Realtime:Play] ${e.message}`));
          }
          break;

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          if (msg.transcript?.trim()) {
            transcript.push({ speaker: BOT_NAME, text: msg.transcript.trim(), timestamp: Date.now() });
            lastRespondedIndex = transcript.length;
            console.log(`[Realtime:Bot] "${msg.transcript.trim().slice(0, 80)}"`);
          }
          break;

        case "error":
          console.log(`[Realtime:Error] ${JSON.stringify(msg.error)}`);
          break;
      }
    } catch {}
  });

  realtimeWs.addEventListener("close", () => { console.log("[Realtime] Disconnected"); realtimeWs = null; });
  realtimeWs.addEventListener("error", (e) => console.log(`[Realtime] Error: ${e.message || "?"}`));
  console.log("[Realtime] Mode active — <1s latency, audio-in/audio-out via OpenAI");
}

function playPCM24k(pcm16Buffer) {
  const wavPath = join(STORAGE, "recordings", `rt-${Date.now()}.wav`);
  const hdr = Buffer.alloc(44);
  const ds = pcm16Buffer.length;
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + ds, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(24000, 24);
  hdr.writeUInt32LE(24000 * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(ds, 40);
  writeFileSync(wavPath, Buffer.concat([hdr, pcm16Buffer]));
  return playViaPulseAudio(wavPath);
}

// ══════════════════════════════════════════════════════════════════════════
// MODE 2: STREAMING PIPELINE
// agents-js style: STT → silence → LLM stream → sentence splitter → TTS
// First audio out ~300ms after user finishes speaking.
// ══════════════════════════════════════════════════════════════════════════

let currentSpeakerName = "participant";
let sttWs = null;
let sttTimer = null;
let audioBuffer = [];
let lastSpeechTime = 0;
let lastRespondedIndex = 0;
let pendingText = "";
let respondTimer = null;
const SILENCE_MS = 1800;     // wait for this silence before responding
const MIN_WORDS = 2;
const STT_SAMPLE_RATE = 16000;

async function startPipelineMode() {
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
    const p = process.env.GROQ_API_KEY ? "Groq" : process.env.OPENAI_API_KEY ? "OpenAI" : "none";
    console.log(`[Pipeline] STT: batch (${p}) — silence=${SILENCE_MS}ms`);
  }

  startResponseLoop();
}

// ── Deepgram streaming STT ───────────────────────────────────────────────

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
      const t = setTimeout(() => reject(new Error("timeout")), 10000);
      sttWs.addEventListener("open", () => { clearTimeout(t); resolve(); });
      sttWs.addEventListener("error", (e) => { clearTimeout(t); reject(e); });
    });

    sttWs.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (data.type !== "Results" || !data.is_final) return;
        const text = data.channel?.alternatives?.[0]?.transcript?.trim();
        if (!text || text.length < 2) return;
        const last = transcript[transcript.length - 1];
        if (!last || last.text !== text) {
          const speaker = currentSpeakerName || "participant";
          transcript.push({ speaker, text, timestamp: Date.now() });
          lastSpeechTime = Date.now();
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

    console.log("[Pipeline] STT: Deepgram streaming (nova-3, ~200ms)");
  } catch (e) {
    console.log(`[STT:Deepgram] Failed: ${e.message} — using batch`);
    sttWs = null;
    sttTimer = setInterval(() => flushBatchSTT(), 1500);
  }
}

// ── Batch STT fallback ───────────────────────────────────────────────────

async function flushBatchSTT() {
  if (audioBuffer.length === 0) return;
  const chunks = audioBuffer.splice(0);
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(len);
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
        lastSpeechTime = Date.now();
        console.log(`[STT:Batch] [${speaker}] "${text.trim().slice(0, 80)}"`);
      }
    }
  } catch (e) { console.log(`[STT] ${e.message}`); }
}

async function batchTranscribe(wavBuf) {
  const model = process.env.STT_MODEL || "whisper-large-v3-turbo";
  const isOpenai = model.includes("gpt-4o") || model === "whisper-1";
  if (isOpenai && process.env.OPENAI_API_KEY) return sttHTTP("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, model, wavBuf);
  if (!isOpenai && process.env.GROQ_API_KEY) return sttHTTP("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, model, wavBuf);
  if (process.env.GROQ_API_KEY) return sttHTTP("https://api.groq.com/openai/v1/audio/transcriptions", process.env.GROQ_API_KEY, "whisper-large-v3-turbo", wavBuf);
  if (process.env.OPENAI_API_KEY) return sttHTTP("https://api.openai.com/v1/audio/transcriptions", process.env.OPENAI_API_KEY, "whisper-1", wavBuf);
  return null;
}

async function sttHTTP(url, key, model, buf) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "a.wav");
  fd.append("model", model);
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!r.ok) { console.log(`[STT] ${r.status}`); return null; }
  return (await r.json()).text;
}

// ── Response loop (agents-js style: sentence-level pipelining) ───────────

function startResponseLoop() {
  const llm = getLLMConfig();
  if (!llm.apiKey) { console.log("[Pipeline] No LLM key — bot will listen only"); return; }
  console.log(`[Pipeline] Response loop: ${llm.provider}:${llm.model} (sentence-level TTS)`);

  respondTimer = setInterval(async () => {
    if (!session || session.state !== "active" || isSpeaking) return;
    if (Date.now() - lastSpeechTime < SILENCE_MS) return;
    if (lastSpeechTime === 0) return; // nobody has spoken yet

    const newEntries = transcript.slice(lastRespondedIndex).filter(e => e.speaker !== BOT_NAME);
    if (newEntries.length === 0) return;
    const words = newEntries.reduce((n, e) => n + e.text.split(/\s+/).length, 0);
    if (words < MIN_WORDS) return;

    // Mark responded so we don't double-respond
    const respondingTo = transcript.length;
    lastRespondedIndex = respondingTo;

    const context = transcript.slice(-20).map(e => `[${e.speaker}]: ${e.text}`).join("\n");

    try {
      await streamingRespond(context);
    } catch (e) {
      console.log(`[Pipeline] Response error: ${e.message}`);
    }
  }, 300);
}

/**
 * agents-js style concurrent pipeline:
 * LLM streams text → sentence splitter → each sentence → TTS immediately
 * Perceived latency = time_to_first_sentence_end (~1-2 words in) + TTS TTFB
 */
async function streamingRespond(context) {
  const llm = getLLMConfig();
  isSpeaking = true;

  try {
    const r = await fetch(`${llm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: `Transcript:\n${context}\n\nRespond naturally if someone needs you, or respond with just "" to stay silent.` },
        ],
        max_completion_tokens: 120,
        temperature: 0.75,
        stream: true,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!r.ok) { console.log(`[LLM] ${r.status}`); return; }

    // Read SSE stream, split into sentences, TTS each sentence immediately
    let buffer = "";
    let fullText = "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let raw = "";

    // Sentence queue — process one at a time to avoid audio overlap
    const sentenceQueue = [];
    let processingQueue = false;

    const processQueue = async () => {
      if (processingQueue) return;
      processingQueue = true;
      while (sentenceQueue.length > 0) {
        const sentence = sentenceQueue.shift();
        await speakSentence(sentence);
      }
      processingQueue = false;
    };

    const flushSentence = (sentence) => {
      const clean = sentence.replace(/^["']|["']$/g, "").trim();
      if (!clean || clean === '""' || clean.length < 2) return;
      console.log(`[Pipeline:Sentence] "${clean}"`);
      sentenceQueue.push(clean);
      processQueue(); // fire and forget — plays in order
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });

      const lines = raw.split("\n");
      raw = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const d = line.slice(6).trim();
        if (d === "[DONE]") break;
        try {
          const delta = JSON.parse(d).choices?.[0]?.delta?.content;
          if (delta) {
            buffer += delta;
            fullText += delta;

            // Split on sentence boundaries: ". " / "? " / "! " / ".\n"
            const BOUNDARY = /([.!?]+[\s\n]+|[.!?]+$)/;
            const parts = buffer.split(BOUNDARY);
            // parts: [text, boundary, text, boundary, ...]
            // Keep last part as pending buffer (may be incomplete)
            if (parts.length > 2) {
              // Reconstruct complete sentences
              let i = 0;
              while (i < parts.length - 2) {
                const sentence = (parts[i] + (parts[i + 1] || "")).trim();
                if (sentence) flushSentence(sentence);
                i += 2;
              }
              buffer = parts[parts.length - 1] || "";
            }
          }
        } catch {}
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) flushSentence(buffer.trim());

    // Wait for all queued sentences to finish playing
    while (sentenceQueue.length > 0 || processingQueue) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (fullText.trim() && fullText.trim() !== '""') {
      transcript.push({ speaker: BOT_NAME, text: fullText.replace(/^["']|["']$/g, "").trim(), timestamp: Date.now() });
      lastRespondedIndex = transcript.length;
    }
  } finally {
    isSpeaking = false;
  }
}

async function speakSentence(text) {
  const ttsModel = process.env.TTS_MODEL || "tts-1";
  const isGroq = ttsModel === "groq" || ttsModel.includes("orpheus");
  const audioPath = join(STORAGE, "recordings", `tts-${Date.now()}.mp3`);
  let playPath = audioPath;
  let ok = false;

  if (isGroq && process.env.GROQ_API_KEY) {
    playPath = audioPath.replace(".mp3", ".wav");
    ok = await ttsHTTP("https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY, "canopylabs/orpheus-v1-english", text, "hannah", "wav", playPath);
  }
  if (!ok && !isGroq && process.env.OPENAI_API_KEY) {
    ok = await ttsHTTP("https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY, ttsModel, text, "nova", "mp3", audioPath);
    playPath = audioPath;
  }
  if (!ok && process.env.GROQ_API_KEY) {
    playPath = audioPath.replace(".mp3", ".wav");
    ok = await ttsHTTP("https://api.groq.com/openai/v1/audio/speech", process.env.GROQ_API_KEY, "canopylabs/orpheus-v1-english", text, "hannah", "wav", playPath);
  }
  if (!ok && process.env.OPENAI_API_KEY) {
    playPath = audioPath;
    ok = await ttsHTTP("https://api.openai.com/v1/audio/speech", process.env.OPENAI_API_KEY, "tts-1", text, "nova", "mp3", playPath);
  }
  if (!ok) return;

  // Unmute
  try {
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll("button")) {
        const l = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (l.includes("turn on microphone") || l.includes("unmute")) { btn.click(); return; }
      }
    });
    await page.waitForTimeout(200);
  } catch {}

  await playViaPulseAudio(playPath);
}

// ── Manual speak (from Daemora agent via POST /speak) ────────────────────

async function speak(text) {
  if (!text || !session || session.state !== "active") return "Not in meeting";
  if (isSpeaking) return "Already speaking";
  isSpeaking = true;
  try {
    await speakSentence(text);
    transcript.push({ speaker: BOT_NAME, text, timestamp: Date.now() });
    lastRespondedIndex = transcript.length;
    return `Spoke: "${text.slice(0, 80)}"`;
  } catch (e) {
    return `Speak error: ${e.message}`;
  } finally {
    isSpeaking = false;
  }
}

// ── LLM config ───────────────────────────────────────────────────────────

function getLLMConfig() {
  const [provider, model] = LLM_MODEL.includes(":") ? LLM_MODEL.split(":", 2) : ["openai", LLM_MODEL];
  const map = {
    groq:       { base: "https://api.groq.com/openai/v1",       key: process.env.GROQ_API_KEY },
    openai:     { base: process.env.LLM_BASE_URL || "https://api.openai.com/v1", key: process.env.OPENAI_API_KEY },
    deepseek:   { base: "https://api.deepseek.com/v1",           key: process.env.DEEPSEEK_API_KEY },
    xai:        { base: "https://api.x.ai/v1",                   key: process.env.XAI_API_KEY },
    openrouter: { base: "https://openrouter.ai/api/v1",          key: process.env.OPENROUTER_API_KEY },
    mistral:    { base: "https://api.mistral.ai/v1",             key: process.env.MISTRAL_API_KEY },
    anthropic:  { base: "https://api.anthropic.com/v1",          key: process.env.ANTHROPIC_API_KEY },
  };
  const c = map[provider] || map.openai;
  return { provider, model, baseURL: c.base, apiKey: c.key || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY };
}

function buildSystemPrompt() {
  return `You are ${BOT_NAME} — a real AI meeting participant. You are in a live meeting right now.

Rules:
- Respond in 1-2 short sentences MAX. Natural, conversational, human.
- If someone asks you something → answer it directly.
- If someone says your name → respond.
- If the conversation doesn't need you → respond with "" (empty string, nothing).
- NEVER give presentations or long explanations. One sentence is usually enough.
- NEVER start with "Certainly!" or "Great question!" — just answer.`;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function ttsHTTP(url, key, model, text, voice, fmt, path) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text, voice, response_format: fmt }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.log(`[TTS] ${model}: ${r.status}`); return false; }
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch (e) { console.log(`[TTS] ${e.message}`); return false; }
}

// ── Audio utilities ──────────────────────────────────────────────────────

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
// LEAVE
// ══════════════════════════════════════════════════════════════════════════

async function leaveMeeting() {
  if (respondTimer) { clearInterval(respondTimer); respondTimer = null; }
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
