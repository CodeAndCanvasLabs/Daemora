/**
 * LiveKitServer — manages a local livekit-server process.
 *
 * In dev mode, Daemora auto-starts livekit-server --dev on port 7880
 * as a loopback SFU. The browser and voice agent both connect to it.
 * In production, this points to a cloud LiveKit instance instead.
 *
 * Lifecycle:
 *   1. Check if 7880 is already occupied → reuse
 *   2. Find livekit-server binary on PATH
 *   3. Spawn with --dev flag (generates devkey/secret automatically)
 *   4. Wait for port to bind (8s timeout)
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import { createLogger } from "../util/logger.js";

const log = createLogger("voice.livekit");

const DEFAULT_PORT = 7880;

export class LiveKitServer {
  private child: ChildProcess | null = null;
  private readonly port: number;

  constructor(port?: number) {
    this.port = port ?? DEFAULT_PORT;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get isManaged(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /**
   * Ensure livekit-server is running. If already listening on the port,
   * reuse it. Otherwise spawn a new --dev instance.
   */
  async ensureRunning(): Promise<void> {
    // Already listening? Reuse.
    if (await this.isPortOpen(200)) {
      log.info({ port: this.port }, "livekit-server already running");
      return;
    }

    // Find the binary
    const binary = this.findBinary();
    if (!binary) {
      log.warn("livekit-server not found on PATH — voice will not work");
      log.warn("Install: brew install livekit (macOS) or curl -sSL https://get.livekit.io | bash");
      return;
    }

    log.info({ binary, port: this.port }, "spawning livekit-server --dev");
    this.child = spawn(binary, ["--dev", "--bind", "127.0.0.1", "--port", String(this.port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s && /(starting|listening|error|ready)/i.test(s)) {
        log.info(`[livekit] ${s.slice(0, 200)}`);
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s && /(starting|listening|error|ready)/i.test(s)) {
        log.info(`[livekit] ${s.slice(0, 200)}`);
      }
    });
    this.child.on("exit", (code, signal) => {
      log.info({ code, signal }, "livekit-server exited");
      this.child = null;
    });

    // Wait for port to bind
    const up = await this.waitForPort(8_000);
    if (!up) {
      this.stop();
      throw new Error(`livekit-server did not bind 127.0.0.1:${this.port} within 8s`);
    }
    log.info({ port: this.port }, "livekit-server ready");
  }

  stop(): void {
    if (!this.child || this.child.killed) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child && !this.child.killed) this.child.kill("SIGKILL");
    }, 3000).unref();
  }

  private findBinary(): string | null {
    const candidates = [
      "livekit-server",
      "/opt/homebrew/bin/livekit-server",
      "/usr/local/bin/livekit-server",
    ];
    for (const c of candidates) {
      try {
        execSync(`command -v ${c}`, { stdio: "ignore" });
        return c;
      } catch { /* not found */ }
    }
    return null;
  }

  private isPortOpen(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: this.port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    });
  }

  private async waitForPort(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isPortOpen(500)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
