/**
 * OS-level sandbox for child processes a tenant can spawn (shell commands,
 * project builds, stdio MCP servers). In managed (multi-tenant) mode on macOS
 * we wrap the process in `sandbox-exec` with a seatbelt profile that lets it
 * run + reach the network and system libs, but DENIES file content reads/writes
 * outside the tenant's own dir (home / repo / sibling tenants live under /Users).
 * It also scrubs the env (no signing secret / vault passphrase / API keys leak)
 * and points HOME at the tenant so tool caches don't pollute the project.
 *
 * This is the actual filesystem boundary for local dev; in cloud each tenant is
 * a separate Fly Machine with only /data mounted, so there's no host to reach.
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Only these harmless OS vars reach a sandboxed child — never the process env
// (which may carry INTERNAL_SIGNING_SECRET, the vault passphrase, API keys, …).
const SHELL_ENV_WHITELIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "LC_MESSAGES", "TERM", "USER", "LOGNAME", "SHELL", "TZ", "PWD", "HOSTNAME",
  "COLUMNS", "LINES", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

export function safeShellEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SHELL_ENV_WHITELIST) { const v = process.env[k]; if (v !== undefined) out[k] = v; }
  return out;
}

export function macSandboxProfile(allowRoots: readonly string[], denyRoots: readonly string[]): string {
  const rw = allowRoots.map((r) => `(subpath ${JSON.stringify(r)})`).join(" ");
  const deny = denyRoots.map((r) => `(subpath ${JSON.stringify(r)})`).join(" ");
  // Allow-by-default so binaries load + run; deny file CONTENT reads/writes
  // under the sensitive trees; re-allow the tenant's own dir. file-read-METADATA
  // stays allowed so module resolution can stat parents (else realpath EPERM).
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read-data file-write* file-write-create ${deny})`,
    `(allow file-read-data file-write* file-write-create ${rw})`,
  ].join("\n");
}

/** Minimal sandbox descriptor — derive from the FilesystemGuard at the call site. */
export interface SandboxSpec {
  readonly dataDir?: string;
  readonly allowRoots: readonly string[];
}

/** Build the deny roots (host home / repo / sibling tenants — all under /Users on macOS). */
function denyRootsFor(): string[] {
  return Array.from(new Set(["/Users", process.env["HOME"] ?? ""].filter(Boolean)));
}

/** True when we can + should wrap a child in the OS sandbox. */
export function canSandbox(spec?: SandboxSpec): boolean {
  return !!spec && process.platform === "darwin" && existsSync(SANDBOX_EXEC) && spec.allowRoots.length > 0;
}

/**
 * Spawn `argv[0]` with `argv[1..]`, confined to the tenant sandbox when `spec`
 * is provided (managed mode). For a shell command pass `["/bin/bash","-c",cmd]`;
 * for a program pass `[cmd, ...args]`. When `spec` is absent (single-user/off
 * mode) the child runs normally with the full env (back-compat).
 */
export function sandboxedSpawn(
  argv: readonly string[],
  opts: { spec?: SandboxSpec; cwd?: string; signal?: AbortSignal; stdio?: StdioOptions; extraEnv?: Record<string, string> } = {},
): ChildProcess {
  const [program, ...rest] = argv;
  const sandbox = canSandbox(opts.spec);
  const baseEnv = opts.spec
    ? { ...safeShellEnv(), ...(opts.spec.dataDir ? { HOME: opts.spec.dataDir } : {}) }
    : process.env;
  const env = { ...baseEnv, ...(opts.extraEnv ?? {}) };
  const common = {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env,
    stdio: opts.stdio ?? "inherit",
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as const;

  if (sandbox && opts.spec) {
    const allow = Array.from(new Set([...opts.spec.allowRoots, ...(opts.spec.dataDir ? [opts.spec.dataDir] : [])]));
    const profile = macSandboxProfile(allow, denyRootsFor());
    return spawn(SANDBOX_EXEC, ["-p", profile, program!, ...rest], common);
  }
  return spawn(program!, rest, common);
}
