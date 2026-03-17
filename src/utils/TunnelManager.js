/**
 * TunnelManager — auto-exposes local server for Twilio webhooks.
 *
 * Same approach as OpenClaw voice-call extension:
 *   1. DAEMORA_PUBLIC_URL / SERVER_URL set → use as-is (production)
 *   2. NGROK_AUTHTOKEN set → spawn ngrok CLI, parse URL from JSON stdout
 *   3. Tailscale serve/funnel → spawn tailscale CLI (if TAILSCALE_MODE set)
 *   4. Nothing → log setup instructions
 *
 * Sets process.env.DAEMORA_PUBLIC_URL + VOICE_WEBHOOK_BASE_URL.
 */

import { spawn } from "node:child_process";

let _tunnel = null;

function _setUrls(url) {
  process.env.DAEMORA_PUBLIC_URL = url;
  process.env.VOICE_WEBHOOK_BASE_URL = url;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start tunnel if DAEMORA_PUBLIC_URL not already configured.
 * @param {number} port
 * @returns {Promise<string>} resolved public URL
 */
export async function ensurePublicUrl(port) {
  const existing = process.env.DAEMORA_PUBLIC_URL || process.env.SERVER_URL;
  if (existing) {
    process.env.VOICE_WEBHOOK_BASE_URL = process.env.VOICE_WEBHOOK_BASE_URL || existing;
    console.log(`[Tunnel] Public URL: ${existing} (from config)`);
    return existing;
  }

  // 1. ngrok — spawn CLI, parse JSON stdout (same as OpenClaw)
  if (process.env.NGROK_AUTHTOKEN) {
    try {
      const url = await _startNgrok(port, process.env.NGROK_AUTHTOKEN);
      _setUrls(url);
      console.log(`[Tunnel] ngrok: ${url}`);
      return url;
    } catch (e) {
      console.log(`[Tunnel] ngrok failed: ${e.message}`);
    }
  }

  // 2. Tailscale serve/funnel (if TAILSCALE_MODE=serve|funnel)
  const tsMode = process.env.TAILSCALE_MODE;
  if (tsMode === "serve" || tsMode === "funnel") {
    try {
      const url = await _startTailscale(tsMode, port);
      _setUrls(url);
      console.log(`[Tunnel] tailscale ${tsMode}: ${url}`);
      return url;
    } catch (e) {
      console.log(`[Tunnel] tailscale failed: ${e.message}`);
    }
  }

  // 3. Auto-detect: try ngrok CLI without token, then tailscale
  if (await _isCmdAvailable("ngrok")) {
    try {
      const url = await _startNgrok(port);
      _setUrls(url);
      console.log(`[Tunnel] ngrok (no auth): ${url}`);
      return url;
    } catch (e) {
      console.log(`[Tunnel] ngrok auto-detect failed: ${e.message}`);
    }
  }

  // 4. Nothing worked
  console.log("[Tunnel] No public URL. Voice calls & meetings won't work.");
  console.log("[Tunnel] Options:");
  console.log("[Tunnel]   Production  → set DAEMORA_PUBLIC_URL=https://your-server.com");
  console.log("[Tunnel]   Local dev   → install ngrok (brew install ngrok) + set NGROK_AUTHTOKEN");
  console.log("[Tunnel]   Tailscale   → set TAILSCALE_MODE=serve or TAILSCALE_MODE=funnel");
  return "";
}

/**
 * Close the active tunnel on shutdown.
 */
export async function closeTunnel() {
  if (!_tunnel) return;
  try {
    if (_tunnel.proc) _tunnel.proc.kill("SIGTERM");
    if (_tunnel.stop) await _tunnel.stop();
  } catch {}
  _tunnel = null;
}

// ── ngrok (CLI spawn, same as OpenClaw) ───────────────────────────────────────

function _startNgrok(port, authToken) {
  return new Promise(async (resolve, reject) => {
    // Set auth token if provided
    if (authToken) {
      try { await _runCmd("ngrok", ["config", "add-authtoken", authToken]); } catch {}
    }

    const args = ["http", String(port), "--log", "stdout", "--log-format", "json"];
    const proc = spawn("ngrok", args, { stdio: ["ignore", "pipe", "pipe"] });

    let resolved = false;
    let buf = "";

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        reject(new Error("ngrok startup timed out (30s)"));
      }
    }, 30000);

    const processLine = (line) => {
      if (resolved) return;
      try {
        const log = JSON.parse(line);
        // ngrok logs "started tunnel" with url field
        if ((log.msg === "started tunnel" && log.url) || (log.addr && log.url)) {
          resolved = true;
          clearTimeout(timeout);
          _tunnel = {
            type: "ngrok",
            proc,
            stop: async () => {
              proc.kill("SIGTERM");
              await new Promise((r) => { proc.on("close", r); setTimeout(r, 2000); });
            },
          };
          resolve(log.url);
        }
      } catch {}
    };

    proc.stdout.on("data", (data) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) if (line.trim()) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("ERR_NGROK") && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok error: ${msg.trim()}`));
      }
    });

    proc.on("error", (e) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(e); }
    });

    proc.on("close", (code) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`ngrok exited with code ${code}`)); }
    });
  });
}

// ── Tailscale serve/funnel (same as OpenClaw) ─────────────────────────────────

async function _startTailscale(mode, port) {
  const dnsName = await _getTailscaleDns();
  if (!dnsName) throw new Error("Could not get Tailscale DNS name. Is Tailscale running?");

  const localUrl = `http://127.0.0.1:${port}`;

  return new Promise((resolve, reject) => {
    const proc = spawn("tailscale", [mode, "--bg", "--yes", localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Tailscale ${mode} timed out (10s)`));
    }, 10000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const publicUrl = `https://${dnsName}`;
        _tunnel = {
          type: "tailscale",
          stop: () => _runCmd("tailscale", [mode, "off"]).catch(() => {}),
        };
        resolve(publicUrl);
      } else {
        reject(new Error(`Tailscale ${mode} failed with code ${code}`));
      }
    });

    proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function _getTailscaleDns() {
  try {
    const out = await _runCmd("tailscale", ["status", "--json"]);
    const status = JSON.parse(out);
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
    proc.on("error", reject);
  });
}

function _isCmdAvailable(cmd) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
