/**
 * DockerMeetingManager — auto-manages Docker container for meeting bot.
 *
 * The user says "join this meeting" → Daemora:
 * 1. Checks if Docker is installed
 * 2. Builds the meeting bot image (first time only, cached after)
 * 3. Starts a container with PulseAudio + Xvfb + Chromium
 * 4. Sends commands via HTTP API (join/speak/leave/listen)
 * 5. Streams transcripts back in real-time
 * 6. Stops container when meeting ends
 *
 * User never touches Docker. It's invisible infrastructure.
 */

import { execSync, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { configStore } from "../config/ConfigStore.js";

// Read from process.env first (vault-injected + reloadFromDb), then directly from SQLite.
function conf(key, fallback = "") {
  return process.env[key] || configStore.get(key) || fallback;
}

/**
 * Resolve meeting bot config from what the user has actually saved.
 * Priority: explicit user setting > auto-detect from available API keys > local fallback.
 * Never hardcodes a provider if that provider's key isn't available.
 */
function resolveMeetingConfig() {
  const hasOpenAI     = !!conf("OPENAI_API_KEY");
  const hasAnthropic  = !!conf("ANTHROPIC_API_KEY");
  const hasGroq       = !!conf("GROQ_API_KEY");
  const hasDeepgram   = !!conf("DEEPGRAM_API_KEY");
  const hasXAI        = !!conf("XAI_API_KEY");
  const hasDeepseek   = !!conf("DEEPSEEK_API_KEY");
  const hasOpenRouter = !!conf("OPENROUTER_API_KEY");
  const hasMistral    = !!conf("MISTRAL_API_KEY");

  // LLM: explicit config > auto-detect from available keys > local Ollama
  const llmModel = conf("MEETING_LLM") || conf("SUB_AGENT_MODEL") || conf("DEFAULT_MODEL") || (() => {
    if (hasOpenAI)     return "openai:gpt-4o-mini";
    if (hasAnthropic)  return "anthropic:claude-haiku-4-5-20251001";
    if (hasGroq)       return "groq:llama-3.3-70b-versatile";
    if (hasXAI)        return "xai:grok-3-mini";
    if (hasDeepseek)   return "deepseek:deepseek-chat";
    if (hasOpenRouter) return "openrouter:meta-llama/llama-3.1-8b-instruct:free";
    if (hasMistral)    return "mistral:mistral-small-latest";
    return "ollama:llama3.2"; // local — requires Ollama running on host
  })();

  // TTS: explicit config > auto-detect from available keys > espeak (local, no key needed)
  const ttsModel = conf("TTS_MODEL") || (() => {
    if (hasOpenAI) return "tts-1";
    if (hasGroq)   return "groq-tts";
    return "espeak"; // local TTS — installed in Docker image
  })();

  const ttsVoice = conf("TTS_VOICE") || (() => {
    if (ttsModel.includes("tts-1") || ttsModel.includes("gpt")) return "nova";
    if (ttsModel.includes("groq") || ttsModel.includes("orpheus")) return "hannah";
    return ""; // provider default or espeak default
  })();

  // STT: explicit config > auto-detect from available keys > empty (listen-only)
  const sttModel = conf("STT_MODEL") || (() => {
    if (hasDeepgram) return "nova-3";             // streaming, ~200ms
    if (hasGroq)     return "whisper-large-v3-turbo"; // batch, ~500ms
    if (hasOpenAI)   return "whisper-1";          // batch, ~1s
    return ""; // no key — bot listens but cannot transcribe
  })();

  return {
    llmModel,
    ttsModel,
    ttsVoice,
    ttsGroqModel: conf("TTS_GROQ_MODEL") || "canopylabs/orpheus-v1-english",
    sttModel,
    meetingMode: conf("MEETING_MODE", "auto"),
    llmBaseUrl:  conf("OPENAI_BASE_URL"),
    ollamaUrl:   conf("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1"),
  };
}

const IMAGE_NAME = "daemora-meeting-bot";
const CONTAINER_PREFIX = "daemora-meeting-";
const CONTAINER_PORT = 3456;

let dockerAvailable = null;

// ── Docker detection ────────────────────────────────────────────────────

/**
 * Check if Docker is installed and running.
 */
export function isDockerAvailable() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    dockerAvailable = true;
    console.log("[DockerMeeting] Docker detected and running");
  } catch {
    dockerAvailable = false;
    console.log("[DockerMeeting] Docker not available — using native mode");
  }
  return dockerAvailable;
}

// ── Image management ────────────────────────────────────────────────────

/**
 * Build the meeting bot Docker image (idempotent — skips if already built).
 */
export function ensureImage() {
  if (!isDockerAvailable()) return false;

  try {
    // Check if image exists
    const images = execSync(`docker images -q ${IMAGE_NAME}`, { encoding: "utf-8", timeout: 10000 }).trim();
    if (images) {
      console.log(`[DockerMeeting] Image ${IMAGE_NAME} exists`);
      return true;
    }
  } catch {}

  // Build image
  const dockerDir = join(import.meta.dirname, "docker");
  if (!existsSync(join(dockerDir, "Dockerfile"))) {
    console.log("[DockerMeeting] Dockerfile not found — can't build image");
    return false;
  }

  console.log(`[DockerMeeting] Building image ${IMAGE_NAME} (first time — may take 2-3 minutes)...`);
  try {
    // Copy project files needed for the container
    const projectRoot = join(import.meta.dirname, "../..");
    execSync(`docker build -t ${IMAGE_NAME} -f ${join(dockerDir, "Dockerfile")} ${projectRoot}`, {
      stdio: "inherit",
      timeout: 600000, // 10 min (first build downloads ~800MB of Playwright deps)
    });
    console.log(`[DockerMeeting] Image ${IMAGE_NAME} built successfully`);
    return true;
  } catch (e) {
    console.log(`[DockerMeeting] Image build failed: ${e.message}`);
    return false;
  }
}

// ── Container lifecycle ──────────────────────────────────────────────────

/**
 * Start a meeting bot container.
 * @param {string} sessionId
 * @param {object} envVars — API keys to pass to container
 * @returns {{ port: number, containerId: string } | null}
 */
export function startContainer(sessionId, envVars = {}) {
  if (!ensureImage()) return null;

  const containerName = `${CONTAINER_PREFIX}${sessionId}`;
  const hostPort = CONTAINER_PORT + Math.floor(Math.random() * 1000);

  // Build env args
  const envArgs = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (value) envArgs.push("-e", `${key}=${value}`);
  }

  try {
    // Use execFileSync (array args) to handle values with spaces (e.g. BOT_NAME="Daemora Bot")
    const containerId = execFileSync("docker", [
      "run", "-d",
      "--name", containerName,
      "-p", `${hostPort}:${CONTAINER_PORT}`,
      "--shm-size=2g", // needed for Chromium
      "--add-host=host.docker.internal:host-gateway", // Linux: expose host for Ollama
      ...envArgs,
      IMAGE_NAME,
    ], { encoding: "utf-8", timeout: 30000 }).trim();

    console.log(`[DockerMeeting] Container ${containerName} started (port ${hostPort})`);

    // Wait for container to be ready
    for (let i = 0; i < 30; i++) {
      try {
        const res = execSync(`curl -s http://localhost:${hostPort}/health`, { encoding: "utf-8", timeout: 3000 });
        if (res.includes("ok")) {
          console.log(`[DockerMeeting] Container ready`);
          return { port: hostPort, containerId, containerName };
        }
      } catch {}
      execSync("sleep 1", { stdio: "ignore" });
    }

    console.log(`[DockerMeeting] Container failed to become ready`);
    stopContainer(containerName);
    return null;
  } catch (e) {
    console.log(`[DockerMeeting] Container start failed: ${e.message}`);
    return null;
  }
}

/**
 * Stop and remove a meeting bot container.
 */
export function stopContainer(containerName) {
  try {
    execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, {
      stdio: "ignore", timeout: 15000,
    });
    console.log(`[DockerMeeting] Container ${containerName} stopped`);
  } catch {}
}

/**
 * Stop all meeting bot containers.
 */
export function stopAllContainers() {
  try {
    const containers = execSync(
      `docker ps -q --filter name=${CONTAINER_PREFIX}`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (containers) {
      execSync(`docker stop ${containers}; docker rm ${containers}`, { stdio: "ignore", timeout: 15000 });
      console.log("[DockerMeeting] All meeting containers stopped");
    }
  } catch {}
}

// ── Container API client ─────────────────────────────────────────────────

/**
 * Send command to meeting bot container.
 */
export async function containerAPI(port, method, path, body = null) {
  const url = `http://localhost:${port}${path}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Container API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Join meeting via Docker container.
 */
export async function dockerJoinMeeting(sessionId, opts) {
  // All config auto-resolved from SQLite/vault — agent never passes keys or models.
  const mc = resolveMeetingConfig();
  const envVars = {
    // API keys — from vault (injected into process.env on unlock)
    OPENAI_API_KEY:    conf("OPENAI_API_KEY"),
    GROQ_API_KEY:      conf("GROQ_API_KEY"),
    DEEPGRAM_API_KEY:  conf("DEEPGRAM_API_KEY"),
    ELEVENLABS_API_KEY:conf("ELEVENLABS_API_KEY"),
    ANTHROPIC_API_KEY: conf("ANTHROPIC_API_KEY"),
    XAI_API_KEY:       conf("XAI_API_KEY"),
    DEEPSEEK_API_KEY:  conf("DEEPSEEK_API_KEY"),
    MISTRAL_API_KEY:   conf("MISTRAL_API_KEY"),
    OPENROUTER_API_KEY:conf("OPENROUTER_API_KEY"),
    // Resolved config — based on available keys, no hardcoded provider assumptions
    TTS_MODEL:      mc.ttsModel,
    TTS_VOICE:      mc.ttsVoice,
    TTS_GROQ_MODEL: mc.ttsGroqModel,
    STT_MODEL:      mc.sttModel,
    LLM_MODEL:      mc.llmModel,
    LLM_BASE_URL:   mc.llmBaseUrl,
    OLLAMA_BASE_URL:mc.ollamaUrl,
    MEETING_MODE:   mc.meetingMode,
    BOT_NAME: opts.displayName || "Daemora",
  };

  const container = startContainer(sessionId, envVars);
  if (!container) return null;

  // Join meeting via container API
  const result = await containerAPI(container.port, "POST", "/join", {
    url: opts.meetingUrl,
    displayName: opts.displayName || "Daemora",
    platform: opts.platform || "meet",
  });

  return { ...result, ...container };
}

/**
 * Speak via Docker container.
 */
export async function dockerSpeak(port, text, opts = {}) {
  return containerAPI(port, "POST", "/speak", {
    text,
    voice: opts.voice,
  });
}

/**
 * Get transcript from Docker container.
 */
export async function dockerListen(port, last = 30) {
  return containerAPI(port, "GET", `/listen?last=${last}`);
}

/**
 * Poll new transcript entries since index N.
 * Returns { entries: [...], total: N, nextSince: N }
 * Agent tracks nextSince to get only new entries on each poll.
 */
export async function dockerPollTranscript(port, since = 0) {
  return containerAPI(port, "GET", `/transcript/new?since=${since}`);
}

/**
 * Leave meeting via Docker container.
 */
export async function dockerLeave(port, containerName) {
  try {
    await containerAPI(port, "POST", "/leave");
  } catch {}
  stopContainer(containerName);
}
