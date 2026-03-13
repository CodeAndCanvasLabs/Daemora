/**
 * executeCommand(cmd, optionsJson?) - Execute a shell command with advanced options.
 * Upgraded from 23-line basic version to support: cwd, timeout, env, background mode, stderr.
 *
 * Filesystem scoping:
 * - If ALLOWED_PATHS is set, the cwd of every command must be within an allowed directory.
 * - If RESTRICT_COMMANDS=true, absolute paths referenced in the command string are also checked.
 *   This prevents "cd / && rm -rf ~/Desktop" style escapes when scoped mode is active.
 */
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config/default.js";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { checkCommand } from "../safety/CommandGuard.js";
import execApproval from "../safety/ExecApproval.js";
import dockerSandbox from "../safety/DockerSandbox.js";
import tenantContext from "../tenants/TenantContext.js";
import { mergeLegacyOptions } from "../utils/mergeToolParams.js";

const DEFAULT_TIMEOUT_MS = 120_000;   // 2 minutes default
const MAX_TIMEOUT_MS = 600_000;       // 10 minutes hard max
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export async function executeCommand(params) {
  const cmd = params?.command || params?.cmd;
  const opts = mergeLegacyOptions(params, ["command", "cmd"]);
  const {
    cwd: cwdRaw = null,
    timeout: timeoutRaw = null,
    env: extraEnv = null,
    background = false,
  } = opts;

  // Resolve working directory
  let cwd = process.cwd();
  if (cwdRaw) {
    const resolved = resolve(cwdRaw);
    if (!existsSync(resolved)) {
      return `Error: Working directory not found: ${cwdRaw}`;
    }
    cwd = resolved;
  }

  // ── Self-protection: never kill Daemora's own process ──
  const ownPid = String(process.pid);
  const pidsInCmd = cmd.match(/\bkill\b.*/) ? (cmd.match(/\b\d{2,}\b/g) || []) : [];
  if (pidsInCmd.includes(ownPid)) {
    return `Command blocked: refusing to kill Daemora's own process (PID ${ownPid}).`;
  }

  // ── Command security guard (always runs, regardless of filesystem config) ──
  const cmdCheck = checkCommand(cmd);
  if (!cmdCheck.allowed) {
    return `Command blocked by security policy: ${cmdCheck.reason}`;
  }

  // ── Exec approval gate — pause for user approval if needed ──
  if (execApproval.needsApproval(cmd)) {
    const decision = await execApproval.requestApproval(cmd, opts.taskId || null);
    if (decision === "deny") {
      return `Command denied by approval gate: "${cmd.slice(0, 80)}". User chose to deny execution.`;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Filesystem scope enforcement ───────────────────────────────────────────
  // Prefer per-tenant resolved config (set by TaskRunner), fall back to global
  const store = tenantContext.getStore();
  const resolvedConfig = store?.resolvedConfig;
  const allowedPaths = resolvedConfig?.allowedPaths || config.filesystem?.allowedPaths || [];
  if (allowedPaths.length > 0) {
    // Always check that the cwd is inside an allowed directory
    const cwdGuard = filesystemGuard.checkRead(cwd);
    if (!cwdGuard.allowed) {
      return `Access denied: Working directory "${cwd}" is outside the allowed paths. ` +
        `Allowed: ${allowedPaths.join(", ")}`;
    }

    // When RESTRICT_COMMANDS=true, also scan command string for absolute path references
    if (config.filesystem?.restrictCommands) {
      // Extract absolute paths from the command (Unix + Windows style)
      const absPathPattern = /(\/[^\s'";|&><$]+|[A-Za-z]:\\[^\s'";|&><$]+)/g;
      const matches = [...cmd.matchAll(absPathPattern)].map((m) => m[1]);
      for (const p of matches) {
        const check = filesystemGuard.checkRead(p);
        if (!check.allowed) {
          return `Access denied: Command references a path outside allowed directories: "${p}". ` +
            `Allowed: ${allowedPaths.join(", ")}`;
        }
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Clamp timeout
  const timeout = timeoutRaw
    ? Math.min(parseInt(timeoutRaw), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  // Merge env
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;

  console.log(`      [executeCommand] Running: ${cmd}${cwdRaw ? ` (cwd: ${cwdRaw})` : ""}${background ? " [background]" : ""}`);

  // ── Docker sandbox mode — route through container ──
  if (config.sandbox?.mode === "docker" && dockerSandbox.isAvailable() && !background) {
    const scope = config.sandbox.docker?.scope === "shared" ? "shared" : (store?.sessionId || "shared");
    return dockerSandbox.exec(scope, cmd, { timeout, cwd });
  }

  // Background mode - spawn detached, return PID immediately
  if (background) {
    try {
      const child = spawn("sh", ["-c", cmd], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return `Background process started (PID: ${child.pid}). Command: ${cmd}`;
    } catch (error) {
      return `Error starting background process: ${error.message}`;
    }
  }

  // Foreground mode - wait for result
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout,
      maxBuffer: MAX_BUFFER,
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`      [executeCommand] Done`);
    return result.toString() || "(command completed with no output)";
  } catch (error) {
    if (error.killed) {
      return `Command timed out after ${timeout / 1000}s. Try a shorter-running command or use background mode: {"background":true}`;
    }

    // Build a useful error message with stdout+stderr
    const parts = [];
    if (error.stdout) parts.push(`stdout:\n${error.stdout.slice(0, 2000)}`);
    if (error.stderr) parts.push(`stderr:\n${error.stderr.slice(0, 2000)}`);
    const exitMsg = error.status !== undefined ? ` (exit code: ${error.status})` : "";

    if (parts.length > 0) {
      return `Command failed${exitMsg}:\n${parts.join("\n---\n")}`;
    }
    return `Command failed${exitMsg}: ${error.message}`;
  }
}

export const executeCommandDescription =
  'executeCommand(cmd: string, optionsJson?: string) - Execute a shell command. optionsJson: {"cwd":"./src","timeout":30000,"env":{"NODE_ENV":"test"},"background":false}. timeout is in ms (max 600000). Use background:true for long-running processes (returns PID immediately).';
