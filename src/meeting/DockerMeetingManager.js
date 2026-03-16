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
  // Pass all provider keys + config to container — bot is autonomous inside
  const envVars = {
    // Provider API keys
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    GROQ_API_KEY: process.env.GROQ_API_KEY || "",
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || "",
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
    XAI_API_KEY: process.env.XAI_API_KEY || "",
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
    // Model config — read from SQLite-backed process.env (set via /api/settings)
    TTS_MODEL: process.env.TTS_MODEL || "tts-1",
    TTS_VOICE: process.env.TTS_VOICE || "",              // e.g. "nova", "alloy", "fritz" — empty = provider default
    TTS_GROQ_MODEL: process.env.TTS_GROQ_MODEL || "",    // Groq TTS model override
    STT_MODEL: process.env.STT_MODEL || "nova-3",        // Deepgram model or Whisper model
    LLM_MODEL: process.env.MEETING_LLM || process.env.SUB_AGENT_MODEL || process.env.DEFAULT_MODEL || "openai:o4-mini",
    LLM_BASE_URL: process.env.OPENAI_BASE_URL || "",
    // Meeting mode: realtime | pipeline | auto
    MEETING_MODE: process.env.MEETING_MODE || "auto",
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
