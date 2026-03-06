/**
 * Docker Sandbox — run commands inside Docker containers for kernel-level isolation.
 *
 * Config:
 *   SANDBOX_MODE=docker          — enable Docker isolation
 *   DOCKER_IMAGE=node:22-slim    — base image
 *   DOCKER_MEMORY=512m           — memory limit
 *   DOCKER_CPUS=0.5              — CPU limit
 *   DOCKER_NETWORK=none          — network mode (none = no network)
 *   DOCKER_SCOPE=session         — "session" (per session) | "shared" (one for all)
 */

import { execSync, spawnSync } from "node:child_process";
import { config } from "../config/default.js";

// containerId → { scope, createdAt, lastUsedAt }
const _containers = new Map();
const CLEANUP_AFTER = 10 * 60 * 1000; // 10 min inactivity

class DockerSandbox {
  constructor() {
    this._available = null; // cached Docker availability check
  }

  /**
   * Check if Docker is available.
   */
  isAvailable() {
    if (this._available !== null) return this._available;
    try {
      execSync("docker info", { stdio: "pipe", timeout: 5000 });
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  /**
   * Ensure a container exists for the given scope.
   * @param {string} scopeId — session ID or "shared"
   * @returns {string} containerId
   */
  ensureContainer(scopeId = "shared") {
    const existing = _containers.get(scopeId);
    if (existing) {
      // Check if container is still running
      try {
        const status = execSync(`docker inspect -f '{{.State.Running}}' ${existing.containerId}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        }).trim();
        if (status === "true") {
          existing.lastUsedAt = Date.now();
          return existing.containerId;
        }
      } catch {
        // Container gone — remove from map and create new
        _containers.delete(scopeId);
      }
    }

    const sandbox = config.sandbox || {};
    const image = sandbox.dockerImage || "node:22-slim";
    const memory = sandbox.dockerMemory || "512m";
    const cpus = sandbox.dockerCpus || "0.5";
    const network = sandbox.dockerNetwork || "none";

    // Create container with security constraints
    const containerName = `daemora-sandbox-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30)}-${Date.now()}`;

    const args = [
      "docker", "run", "-d",
      "--name", containerName,
      "--memory", memory,
      "--cpus", cpus,
      "--network", network,
      "--read-only",
      "--cap-drop", "ALL",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=100m",
      "--tmpfs", "/workspace:rw,size=500m",
      "-w", "/workspace",
      image,
      "tail", "-f", "/dev/null", // Keep container alive
    ];

    try {
      const containerId = execSync(args.join(" "), {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();

      _containers.set(scopeId, {
        containerId,
        containerName,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });

      console.log(`[DockerSandbox] Created container ${containerName} (${containerId.slice(0, 12)}) for scope: ${scopeId}`);
      return containerId;
    } catch (error) {
      throw new Error(`Failed to create Docker container: ${error.message}`);
    }
  }

  /**
   * Execute a command inside a container.
   * @param {string} scopeId
   * @param {string} command
   * @param {object} opts — { timeout, cwd }
   * @returns {string} command output
   */
  exec(scopeId, command, opts = {}) {
    const containerId = this.ensureContainer(scopeId);
    const timeout = opts.timeout || 120_000;
    const cwd = opts.cwd || "/workspace";

    try {
      const result = execSync(`docker exec -w "${cwd}" ${containerId} sh -c ${JSON.stringify(command)}`, {
        encoding: "utf-8",
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const entry = _containers.get(scopeId);
      if (entry) entry.lastUsedAt = Date.now();

      return result || "(command completed with no output)";
    } catch (error) {
      if (error.killed) {
        return `Command timed out after ${timeout / 1000}s inside Docker container.`;
      }
      const parts = [];
      if (error.stdout) parts.push(`stdout:\n${error.stdout.slice(0, 2000)}`);
      if (error.stderr) parts.push(`stderr:\n${error.stderr.slice(0, 2000)}`);
      const exitMsg = error.status !== undefined ? ` (exit code: ${error.status})` : "";
      if (parts.length > 0) return `Command failed${exitMsg}:\n${parts.join("\n---\n")}`;
      return `Command failed${exitMsg}: ${error.message}`;
    }
  }

  /**
   * Copy workspace files into the container.
   */
  copyToContainer(scopeId, hostPath, containerPath = "/workspace") {
    const containerId = this.ensureContainer(scopeId);
    try {
      execSync(`docker cp "${hostPath}/." ${containerId}:${containerPath}`, {
        timeout: 30000,
        stdio: "pipe",
      });
      return true;
    } catch (error) {
      console.log(`[DockerSandbox] Copy failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Remove a container.
   */
  removeContainer(scopeId) {
    const entry = _containers.get(scopeId);
    if (!entry) return;
    try {
      execSync(`docker rm -f ${entry.containerId}`, { stdio: "pipe", timeout: 10000 });
      console.log(`[DockerSandbox] Removed container for scope: ${scopeId}`);
    } catch {}
    _containers.delete(scopeId);
  }

  /**
   * Cleanup inactive containers.
   */
  cleanup() {
    const now = Date.now();
    for (const [scopeId, entry] of _containers.entries()) {
      if (now - entry.lastUsedAt > CLEANUP_AFTER) {
        this.removeContainer(scopeId);
      }
    }
  }

  /**
   * Remove all containers.
   */
  removeAll() {
    for (const scopeId of [..._containers.keys()]) {
      this.removeContainer(scopeId);
    }
  }

  /**
   * List active containers.
   */
  list() {
    return [..._containers.entries()].map(([scopeId, entry]) => ({
      scopeId,
      containerId: entry.containerId.slice(0, 12),
      containerName: entry.containerName,
      createdAt: new Date(entry.createdAt).toISOString(),
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      idleMs: Date.now() - entry.lastUsedAt,
    }));
  }
}

const dockerSandbox = new DockerSandbox();
export default dockerSandbox;
