/**
 * DockerSandbox — kernel-level isolation for `execute_command`.
 *
 * When `SANDBOX_MODE=docker`, every shell invocation goes through
 * `exec(scopeId, command)` here instead of running on the host.
 * Each scope (usually a session id) gets its own long-lived container
 * with:
 *
 *   • `--network none`        — no outbound
 *   • `--read-only`           — host fs is mounted ro
 *   • `--cap-drop ALL`        — drop all Linux capabilities
 *   • `--memory`, `--cpus`    — bounded
 *   • `/tmp` + `/workspace`   — tmpfs writable overlays
 *
 * Containers are reused across calls for the same scope (so the agent
 * keeps its working tree) and auto-cleaned after `CLEANUP_AFTER_MS` of
 * inactivity.
 */

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";

import { createLogger } from "../util/logger.js";

const log = createLogger("docker-sandbox");

const CLEANUP_AFTER_MS = 10 * 60_000;

export interface DockerSandboxOpts {
  readonly image?: string;
  readonly memory?: string;
  readonly cpus?: string;
  readonly network?: "none" | "bridge" | "host";
  readonly tmpWorkspaceMb?: number;
  readonly execTimeoutMs?: number;
}

interface ContainerEntry {
  readonly containerId: string;
  readonly containerName: string;
  readonly createdAt: number;
  lastUsedAt: number;
}

export interface DockerExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly message: string;
}

export class DockerSandbox extends EventEmitter {
  private readonly image: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly network: "none" | "bridge" | "host";
  private readonly tmpWorkspaceMb: number;
  private readonly execTimeoutMs: number;

  private available: boolean | null = null;
  private readonly containers = new Map<string, ContainerEntry>();

  constructor(opts: DockerSandboxOpts = {}) {
    super();
    this.image = opts.image ?? process.env["DOCKER_IMAGE"] ?? "node:22-slim";
    this.memory = opts.memory ?? process.env["DOCKER_MEMORY"] ?? "512m";
    this.cpus = opts.cpus ?? process.env["DOCKER_CPUS"] ?? "0.5";
    this.network = opts.network ?? (process.env["DOCKER_NETWORK"] as "none" | "bridge" | "host" | undefined) ?? "none";
    this.tmpWorkspaceMb = opts.tmpWorkspaceMb ?? 500;
    this.execTimeoutMs = opts.execTimeoutMs ?? 120_000;
  }

  /** Is docker actually usable on this host? Cached after first call. */
  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    try {
      execFileSync("docker", ["info"], { stdio: "pipe", timeout: 5000 });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Ensure a container for this scope exists and is running. */
  ensureContainer(scopeId = "shared"): string {
    const existing = this.containers.get(scopeId);
    if (existing) {
      try {
        const out = execFileSync(
          "docker",
          ["inspect", "-f", "{{.State.Running}}", existing.containerId],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
        ).trim();
        if (out === "true") {
          existing.lastUsedAt = Date.now();
          return existing.containerId;
        }
      } catch {
        this.containers.delete(scopeId);
      }
    }

    const containerName = `daemora-sandbox-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30)}-${Date.now()}`;
    const args = [
      "run", "-d",
      "--name", containerName,
      "--memory", this.memory,
      "--cpus", this.cpus,
      "--network", this.network,
      "--read-only",
      "--cap-drop", "ALL",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=100m",
      "--tmpfs", `/workspace:rw,size=${this.tmpWorkspaceMb}m`,
      "-w", "/workspace",
      this.image,
      "tail", "-f", "/dev/null",
    ];
    const containerId = execFileSync("docker", args, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();

    this.containers.set(scopeId, {
      containerId,
      containerName,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    log.info({ scopeId, containerName, short: containerId.slice(0, 12) }, "container created");
    this.emit("container:created", { scopeId, containerId, containerName });
    return containerId;
  }

  /** Run a shell command inside the scope's container. */
  exec(
    scopeId: string,
    command: string,
    opts: { timeoutMs?: number; cwd?: string } = {},
  ): DockerExecResult {
    const containerId = this.ensureContainer(scopeId);
    const timeoutMs = opts.timeoutMs ?? this.execTimeoutMs;
    const cwd = opts.cwd ?? "/workspace";

    try {
      const stdout = execFileSync(
        "docker",
        ["exec", "-w", cwd, containerId, "sh", "-c", command],
        {
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const entry = this.containers.get(scopeId);
      if (entry) entry.lastUsedAt = Date.now();
      return { ok: true, stdout: stdout || "", message: stdout ? "ok" : "(command completed with no output)" };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        status?: number | null;
        signal?: string;
        killed?: boolean;
      };
      if (err.killed) {
        return { ok: false, stdout: "", message: `Command timed out after ${Math.round(timeoutMs / 1000)}s in Docker sandbox.` };
      }
      const stdout = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString() ?? "";
      const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "";
      const msg =
        `Docker exec failed${err.status != null ? ` (exit ${err.status})` : ""}: ${err.message}`;
      return {
        ok: false,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        ...(err.status != null ? { exitCode: err.status } : {}),
        message: msg,
      };
    }
  }

  /** Copy host files into the container (e.g. user workspace). */
  copyToContainer(scopeId: string, hostPath: string, containerPath = "/workspace"): boolean {
    const containerId = this.ensureContainer(scopeId);
    try {
      execFileSync(
        "docker",
        ["cp", `${hostPath}/.`, `${containerId}:${containerPath}`],
        { stdio: "pipe", timeout: 30_000 },
      );
      return true;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "docker cp failed");
      return false;
    }
  }

  /** Remove a scope's container (force). */
  removeContainer(scopeId: string): void {
    const entry = this.containers.get(scopeId);
    if (!entry) return;
    try {
      execFileSync("docker", ["rm", "-f", entry.containerId], { stdio: "pipe", timeout: 10_000 });
      log.info({ scopeId }, "container removed");
    } catch { /* non-fatal */ }
    this.containers.delete(scopeId);
    this.emit("container:removed", { scopeId });
  }

  /** Drop containers that have been idle past CLEANUP_AFTER_MS. */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [scopeId, entry] of this.containers.entries()) {
      if (now - entry.lastUsedAt > CLEANUP_AFTER_MS) {
        this.removeContainer(scopeId);
        removed++;
      }
    }
    return removed;
  }

  /** Remove every sandbox container — process shutdown. */
  removeAll(): void {
    for (const scope of [...this.containers.keys()]) this.removeContainer(scope);
  }

  list(): readonly {
    scopeId: string;
    containerId: string;
    containerName: string;
    createdAt: string;
    lastUsedAt: string;
    idleMs: number;
  }[] {
    const now = Date.now();
    return [...this.containers.entries()].map(([scopeId, entry]) => ({
      scopeId,
      containerId: entry.containerId.slice(0, 12),
      containerName: entry.containerName,
      createdAt: new Date(entry.createdAt).toISOString(),
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      idleMs: now - entry.lastUsedAt,
    }));
  }
}

export const dockerSandbox = new DockerSandbox();
