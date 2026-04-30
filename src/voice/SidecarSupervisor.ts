/**
 * SidecarSupervisor — manages the Python voice + desktop sidecar process.
 *
 * The sidecar runs as a child process with:
 *   - A random per-spawn DAEMORA_SIDECAR_TOKEN for auth
 *   - All vault secrets inherited via process.env
 *   - LiveKit connection env (URL, API key/secret)
 *
 * Security: the token is generated fresh on every spawn. Only Daemora
 * and the one sidecar process know it. All HTTP calls between them
 * require X-Daemora-Token header.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../util/logger.js";

const log = createLogger("voice.sidecar");

const SIDECAR_PORT = Number(process.env["DAEMORA_SIDECAR_PORT"] ?? "8765");

export interface SidecarStatus {
  running: boolean;
  pid: number | null;
  url: string;
  lastError: string | null;
}

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private token: string | null = null;
  private lastError: string | null = null;
  private starting = false;

  constructor(
    private readonly sidecarDir: string,
    private readonly livekitUrl: string,
    private readonly livekitApiKey: string,
    private readonly livekitApiSecret: string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${SIDECAR_PORT}`;
  }

  get sidecarToken(): string | null {
    return this.token;
  }

  status(): SidecarStatus {
    return {
      running: !!(this.child && !this.child.killed && this.child.exitCode === null),
      pid: this.child?.pid ?? null,
      url: this.url,
      lastError: this.lastError,
    };
  }

  async start(): Promise<SidecarStatus> {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.status();
    }
    if (this.starting) return this.status();
    this.starting = true;

    try {
      // Detect bundled sidecar vs dev venv
      const bundledRoot = process.env["DAEMORA_BUNDLED_BINARIES_DIR"];
      let command: string;
      let args: string[];
      let cwd: string;

      if (bundledRoot) {
        const name = process.platform === "win32" ? "daemora-sidecar.exe" : "daemora-sidecar";
        const frozen = join(bundledRoot, "daemora-sidecar", name);
        if (existsSync(frozen)) {
          command = frozen;
          args = [];
          cwd = join(bundledRoot, "daemora-sidecar");
        } else {
          throw new Error(`Bundled sidecar not found at ${frozen}`);
        }
      } else {
        const python = join(this.sidecarDir, ".venv", "bin", "python");
        if (!existsSync(python)) {
          throw new Error(`Sidecar venv not found at ${python}. Run: cd desktop/sidecar && ./bootstrap.sh`);
        }
        command = python;
        args = ["-m", "daemora_sidecar.main"];
        cwd = this.sidecarDir;
      }

      // Kill stale processes
      await this.killStale();

      this.token = randomBytes(32).toString("hex");

      const childEnv = {
        ...process.env,
        DAEMORA_SIDECAR_TOKEN: this.token,
        DAEMORA_SIDECAR_PORT: String(SIDECAR_PORT),
        DAEMORA_HTTP: `http://127.0.0.1:${process.env["PORT"] ?? "8081"}`,
        LIVEKIT_URL: this.livekitUrl,
        LIVEKIT_API_KEY: this.livekitApiKey,
        LIVEKIT_API_SECRET: this.livekitApiSecret,
        DESKTOP_SIDECAR_TOKEN: this.token,
      };

      log.info({ command, cwd }, "spawning sidecar");
      this.child = spawn(command, args, {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      this.child.stdout?.on("data", (chunk: Buffer) => {
        const s = chunk.toString().trim();
        if (s) log.info(`[sidecar] ${s}`);
      });
      this.child.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString().trim();
        if (s) log.error(`[sidecar] ${s}`);
      });
      this.child.on("exit", (code, signal) => {
        log.info({ code, signal }, "sidecar exited");
        this.lastError = code !== 0 && code !== null ? `exited code ${code}` : null;
        this.child = null;
        this.token = null;
      });
      this.child.on("error", (err) => {
        log.error({ err: err.message }, "sidecar spawn error");
        this.lastError = err.message;
        this.child = null;
        this.token = null;
      });

      // Wait for health
      await this.waitForHealth(10_000);
      this.lastError = null;
      log.info({ pid: this.child?.pid, port: SIDECAR_PORT }, "sidecar healthy");
      return this.status();
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.killed) return;
    this.child.kill("SIGTERM");
    const killAt = Date.now() + 3000;
    while (this.child && !this.child.killed && this.child.exitCode === null && Date.now() < killAt) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.child && !this.child.killed) this.child.kill("SIGKILL");
    this.child = null;
    this.token = null;
  }

  /** Proxy a request to the sidecar with auth token. */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this.token) throw new Error("Sidecar not running");
    return fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        "X-Daemora-Token": this.token,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.url}/health`, {
          headers: { "X-Daemora-Token": this.token! },
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Sidecar /health did not respond within ${timeoutMs}ms`);
  }

  private async killStale(): Promise<void> {
    try {
      const { execSync } = await import("node:child_process");
      try { execSync(`lsof -ti :${SIDECAR_PORT} 2>/dev/null | xargs kill -9`, { stdio: "ignore" }); } catch {}
      try { execSync("pkill -9 -f daemora_sidecar 2>/dev/null", { stdio: "ignore" }); } catch {}
      await new Promise((r) => setTimeout(r, 500));
    } catch {}
  }
}
