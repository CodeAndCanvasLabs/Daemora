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
import requestContext from "../core/RequestContext.js";
import { mergeLegacyOptions } from "../utils/mergeToolParams.js";

const DEFAULT_TIMEOUT_MS = 120_000;   // 2 minutes default
const MAX_TIMEOUT_MS = 600_000;       // 10 minutes hard max
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

// Env vars safe to pass to child processes (everything else stripped if it matches sensitive pattern)
const SAFE_ENV_PASSTHROUGH = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE",
  "NODE_ENV", "TERM", "COLORTERM", "EDITOR", "VISUAL", "TMPDIR", "TMP", "TEMP",
  "HOSTNAME", "LOGNAME", "PWD", "OLDPWD", "SHLVL", "DISPLAY", "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
  "NVM_DIR", "NVM_BIN", "FNM_DIR",
  "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
  "JAVA_HOME", "ANDROID_HOME", "FLUTTER_ROOT",
  "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
  "PYENV_ROOT", "RBENV_ROOT",
]);
const SENSITIVE_ENV_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_SID|_PRIVATE|_PASSPHRASE|VAULT_)$/i;

function _buildSafeEnv(extraEnv) {
  const safe = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SAFE_ENV_PASSTHROUGH.has(k) || !SENSITIVE_ENV_PATTERN.test(k)) {
      safe[k] = v;
    }
  }
  if (extraEnv) Object.assign(safe, extraEnv);
  return safe;
}

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

  // ── Exec approval gate - pause for user approval if needed ──
  if (execApproval.needsApproval(cmd)) {
    const decision = await execApproval.requestApproval(cmd, opts.taskId || null);
    if (decision === "deny") {
      return `Command denied by approval gate: "${cmd.slice(0, 80)}". User chose to deny execution.`;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Filesystem scope enforcement ───────────────────────────────────────────
  // Prefer resolved config from request context (set by TaskRunner), fall back to global
  const store = requestContext.getStore();
  const resolvedConfig = store?.resolvedConfig;
  const allowedPaths = resolvedConfig?.allowedPaths || config.filesystem?.allowedPaths || [];
  const blockedPaths = resolvedConfig?.blockedPaths || config.filesystem?.blockedPaths || [];
  const hasScope = allowedPaths.length > 0 || blockedPaths.length > 0;

  if (hasScope) {
    // Check that the cwd is permitted (respects both allowed + blocked)
    const cwdGuard = filesystemGuard.checkRead(cwd);
    if (!cwdGuard.allowed) {
      return `Access denied: Working directory "${cwd}" is not permitted. ${cwdGuard.reason}`;
    }

    // Scan command string for absolute path references — always when paths are configured
    const absPathPattern = /(\/[^\s'";|&><$]+|[A-Za-z]:\\[^\s'";|&><$]+)/g;
    const matches = [...cmd.matchAll(absPathPattern)].map((m) => m[1]);
    for (const p of matches) {
      const check = filesystemGuard.checkRead(p);
      if (!check.allowed) {
        return `Access denied: Command references a blocked path: "${p}". ${check.reason}`;
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Clamp timeout
  const timeout = timeoutRaw
    ? Math.min(parseInt(timeoutRaw), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  // Build safe env - strip secrets from child process environment
  const env = _buildSafeEnv(extraEnv);

  console.log(`      [executeCommand] Running: ${cmd}${cwdRaw ? ` (cwd: ${cwdRaw})` : ""}${background ? " [background]" : ""}`);

  // ── Docker sandbox mode - route through container ──
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
