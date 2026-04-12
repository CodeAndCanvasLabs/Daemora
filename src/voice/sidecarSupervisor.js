/**
 * Sidecar supervisor — Daemora spawns the Python voice + desktop sidecar
 * as a managed child process with env inherited from the unlocked vault.
 *
 * Security model:
 *  - Daemora generates a random DAEMORA_SIDECAR_TOKEN on every spawn.
 *  - The token is passed to the child process as an env var.
 *  - The sidecar requires this token in X-Daemora-Token on every request.
 *  - The token is known only to Daemora and the one sidecar process — no
 *    other process on the machine can call the sidecar.
 *  - This replaces the /api/voice/env endpoint (which leaked raw keys
 *    over HTTP). The sidecar now inherits Daemora's process.env directly,
 *    so vault secrets never cross a network hop.
 *  - On Daemora shutdown, the child is SIGTERM'd then SIGKILL'd.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/default.js";

const SIDECAR_DIR = join(config.rootDir, "desktop", "sidecar");
const SIDECAR_PYTHON = join(SIDECAR_DIR, ".venv", "bin", "python");
const SIDECAR_PORT = Number(process.env.DAEMORA_SIDECAR_PORT || "8765");

let _child = null;
let _livekitChild = null;
let _token = null;
let _startPromise = null;
let _lastError = null;

export function getSidecarToken() {
  return _token;
}

export function getSidecarUrl() {
  return `http://127.0.0.1:${SIDECAR_PORT}`;
}

export function getSidecarStatus() {
  return {
    running: !!(_child && !_child.killed && _child.exitCode === null),
    pid: _child?.pid || null,
    url: getSidecarUrl(),
    lastError: _lastError,
    livekit: {
      managed: !!(_livekitChild && !_livekitChild.killed && _livekitChild.exitCode === null),
      pid: _livekitChild?.pid || null,
      url: "ws://127.0.0.1:7880",
    },
  };
}

async function _waitForPort(host, port, timeoutMs) {
  const net = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function _startLivekitServer() {
  // If something is already listening on 7880, assume it's livekit-server and reuse.
  if (await _waitForPort("127.0.0.1", 7880, 200)) {
    console.log("[LiveKit] already running on 127.0.0.1:7880");
    return;
  }

  const { execSync } = await import("node:child_process");
  let binary = "livekit-server";
  try {
    execSync(`command -v ${binary}`, { stdio: "ignore" });
  } catch {
    throw new Error(
      "livekit-server not found on PATH. Install: brew install livekit (macOS) or " +
      "curl -sSL https://get.livekit.io | bash (linux). Or run desktop/sidecar/bootstrap.sh."
    );
  }

  console.log("[LiveKit] spawning livekit-server --dev on 127.0.0.1:7880");
  _livekitChild = spawn(binary, ["--dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  _livekitChild.stdout.on("data", (c) => {
    const s = c.toString().trim();
    if (s && /(starting|listening|error)/i.test(s)) console.log(`[LiveKit] ${s.slice(0, 180)}`);
  });
  _livekitChild.stderr.on("data", (c) => {
    const s = c.toString().trim();
    if (s && /(starting|listening|error)/i.test(s)) console.log(`[LiveKit] ${s.slice(0, 180)}`);
  });
  _livekitChild.on("exit", (code, signal) => {
    console.log(`[LiveKit] exited (code=${code} signal=${signal})`);
    _livekitChild = null;
  });

  const up = await _waitForPort("127.0.0.1", 7880, 8000);
  if (!up) {
    try { _livekitChild?.kill("SIGKILL"); } catch {}
    _livekitChild = null;
    throw new Error("livekit-server did not bind 127.0.0.1:7880 within 8s");
  }
  console.log("[LiveKit] ready on 127.0.0.1:7880");
}

async function _waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${getSidecarUrl()}/health`, {
        headers: { "X-Daemora-Token": _token },
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sidecar /health did not come up within ${timeoutMs} ms`);
}

export async function startSidecar() {
  if (_child && !_child.killed && _child.exitCode === null) {
    return { already: true, ...getSidecarStatus() };
  }
  if (_startPromise) return _startPromise;

  _startPromise = (async () => {
    if (!existsSync(SIDECAR_PYTHON)) {
      throw new Error(
        `sidecar venv missing at ${SIDECAR_PYTHON}. Run: cd desktop/sidecar && ./bootstrap.sh`
      );
    }

    // Ensure the loopback LiveKit server is up before the sidecar tries to join.
    await _startLivekitServer();

    _token = randomBytes(32).toString("hex");

    // Inherit Daemora's process.env (vault keys, auth token, etc.) and
    // inject the sidecar token + port explicitly.
    const childEnv = {
      ...process.env,
      DAEMORA_SIDECAR_TOKEN: _token,
      DAEMORA_SIDECAR_PORT: String(SIDECAR_PORT),
      DAEMORA_HTTP: `http://127.0.0.1:${config.port || 8081}`,
      DAEMORA_AUTH_TOKEN: process.env.API_TOKEN || "",
      // Expose the sidecar token to the daemon's own desktop tools too so
      // they can call /desktop/* endpoints authenticated.
      DESKTOP_SIDECAR_TOKEN: _token,
    };

    console.log("[Sidecar] spawning with token auth enabled");
    _child = spawn(SIDECAR_PYTHON, ["-m", "daemora_sidecar.main"], {
      cwd: SIDECAR_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Set the token in our own env too so src/tools/desktop/_sidecar.js
    // and the /api/voice/token endpoint can call the sidecar authenticated.
    process.env.DESKTOP_SIDECAR_TOKEN = _token;
    process.env.DAEMORA_SIDECAR_TOKEN = _token;

    _child.stdout.on("data", (chunk) => {
      const s = chunk.toString().trim();
      if (s) console.log(`[Sidecar] ${s}`);
    });
    _child.stderr.on("data", (chunk) => {
      const s = chunk.toString().trim();
      if (s) console.error(`[Sidecar] ${s}`);
    });
    _child.on("exit", (code, signal) => {
      console.log(`[Sidecar] exited (code=${code} signal=${signal})`);
      _lastError = code !== 0 && code !== null ? `exited code ${code}` : null;
      _child = null;
      _token = null;
    });
    _child.on("error", (err) => {
      console.error("[Sidecar] spawn error:", err.message);
      _lastError = err.message;
      _child = null;
      _token = null;
    });

    try {
      await _waitForHealth();
      console.log(`[Sidecar] healthy on ${getSidecarUrl()} (pid=${_child.pid})`);
      _lastError = null;
      return { already: false, ...getSidecarStatus() };
    } catch (e) {
      _lastError = e.message;
      try { _child?.kill("SIGKILL"); } catch {}
      _child = null;
      _token = null;
      throw e;
    }
  })();

  try {
    return await _startPromise;
  } finally {
    _startPromise = null;
  }
}

async function _killChild(child, label) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch {}
  const killAt = Date.now() + 3000;
  while (child && !child.killed && child.exitCode === null && Date.now() < killAt) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (child && !child.killed && child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch {}
  }
  console.log(`[${label}] stopped`);
}

export async function stopSidecar({ killLivekit = false } = {}) {
  const pid = _child?.pid || null;
  await _killChild(_child, "Sidecar");
  _child = null;
  _token = null;
  if (killLivekit) {
    await _killChild(_livekitChild, "LiveKit");
    _livekitChild = null;
  }
  return { stopped: true, pid };
}

export async function sidecarFetch(path, options = {}) {
  if (!_token) {
    throw new Error("sidecar not running — call startSidecar() first");
  }
  const url = `${getSidecarUrl()}${path}`;
  const headers = { ...(options.headers || {}), "X-Daemora-Token": _token };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(url, { ...options, headers });
}

// Register shutdown hook once
let _shutdownRegistered = false;
export function registerShutdownHook() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const handler = async () => {
    if (_child && !_child.killed) {
      console.log("[Sidecar] shutdown — stopping child");
      try { await stopSidecar({ killLivekit: true }); } catch {}
    } else if (_livekitChild && !_livekitChild.killed) {
      try { await _killChild(_livekitChild, "LiveKit"); } catch {}
      _livekitChild = null;
    }
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  process.once("beforeExit", handler);
}
