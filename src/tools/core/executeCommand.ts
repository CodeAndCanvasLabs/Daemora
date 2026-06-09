import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { createLogger } from "../../util/logger.js";
import { TimeoutError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const log = createLogger("execute_command");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// In sandbox (multitenant) mode the shell gets ONLY these harmless OS vars —
// never the process env, which may carry the signing secret, vault passphrase,
// injected API keys, DATABASE_URL, MASTER_KEK, etc. So `env`, `printenv`,
// `echo $INTERNAL_SIGNING_SECRET` reveal nothing. (In single-user/off mode the
// full env is kept so a self-hoster's own commands work normally.)
const SHELL_ENV_WHITELIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "LC_MESSAGES", "TERM", "USER", "LOGNAME", "SHELL", "TZ", "PWD", "HOSTNAME",
  "COLUMNS", "LINES", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

function safeShellEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SHELL_ENV_WHITELIST) { const v = process.env[k]; if (v !== undefined) out[k] = v; }
  return out;
}

/**
 * macOS seatbelt profile that confines a shell to the tenant's allow-list.
 * `(deny default)` then re-allows only the system paths a binary needs to run
 * plus read/write on the tenant's own roots — so `ls ../../../../crew`,
 * `cat /Users/...`, reads of sibling tenants, etc. are denied by the KERNEL,
 * not by a bypassable string denylist. This is the actual filesystem boundary
 * for local dev; in cloud each tenant is a separate Fly Machine (only /data
 * mounted), so there is no host filesystem to reach in the first place.
 */
function macSandboxProfile(allowRoots: readonly string[], denyRoots: readonly string[]): string {
  const rw = allowRoots.map((r) => `(subpath ${JSON.stringify(r)})`).join(" ");
  const deny = denyRoots.map((r) => `(subpath ${JSON.stringify(r)})`).join(" ");
  // Allow-by-default so binaries (bash, node, next, …) load + run. Then deny
  // file CONTENT reads + writes under the sensitive trees (home / repo / sibling
  // tenants, all under /Users on macOS), then re-allow the tenant's own dir.
  //
  // Crucially we DON'T deny file-read-metadata: Node's module resolution stats
  // (traverses) the parent path components up to the tenant dir, and blocking
  // that `stat` is what produced the realpath EPERM the agent had to hack around.
  // Allowing metadata lets apps run; denying file-read-data still blocks reading
  // or LISTING file/dir contents (getdirentries needs read-data), so
  // `cat /Users/...`, `ls ../../../../crew`, reads of other tenants are all blocked.
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read-data file-write* file-write-create ${deny})`,
    `(allow file-read-data file-write* file-write-create ${rw})`,
  ].join("\n");
}

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  cwd: z.string().optional(),
  /** Hard timeout — protects against hanging commands. */
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /** Output cap to protect context. */
  maxOutputBytes: z.number().int().positive().max(1_000_000).default(100_000),
  /** Defaults to bash on macOS/Linux, cmd on Windows. */
  shell: z.string().optional(),
});

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export function makeExecuteCommandTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, ExecResult> {
  return {
    name: "execute_command",
    description: "Run a shell command. Bounded timeout + output. Blocks commands that reference sensitive paths.",
    category: "shell",
    source: { kind: "core" },
    alwaysOn: true,
    destructive: true,
    inputSchema,
    async execute({ command, cwd, timeoutMs, maxOutputBytes, shell }, { abortSignal }) {
      // Defence-in-depth: scan the command for absolute paths that hit
      // the denylist. Not a sandbox — a real sandbox needs OS-level
      // isolation — but catches the obvious "cat /etc/shadow" class.
      guard.ensureCommandAllowed(command);
      if (cwd) guard.ensureAllowed(cwd, "read");

      const desc = guard.describe();

      // In sandbox/strict mode, when no cwd was given, force the spawn
      // cwd to a safe directory inside the allow-list so the command
      // doesn't inherit the daemon's own cwd (typically the install dir,
      // which the agent shouldn't have free reign over).
      const effectiveCwd = (() => {
        if (cwd) return cwd;
        if (desc.mode === "sandbox" || desc.mode === "strict") {
          // Prefer dataDir; if not in the allow-list, fall back to the
          // first allow entry. If neither exists, we have no safe cwd —
          // refuse rather than silently letting the daemon's cwd leak.
          if (desc.dataDir) return desc.dataDir;
          if (desc.allow.length > 0) return desc.allow[0];
          throw new ValidationError(`${desc.mode} mode requires a cwd inside the allow-list, and none is configured.`);
        }
        return undefined;
      })();

      // Validate cwd up front — Node returns a misleading
      // `spawn /bin/bash ENOENT` when the cwd doesn't exist, which makes
      // the agent retry with different shells fruitlessly. Catch it here
      // so the failure points at the actual problem.
      if (effectiveCwd) {
        if (!existsSync(effectiveCwd)) {
          throw new ValidationError(`cwd does not exist: ${effectiveCwd}`);
        }
        if (!statSync(effectiveCwd).isDirectory()) {
          throw new ValidationError(`cwd is not a directory: ${effectiveCwd}`);
        }
      }

      const started = Date.now();
      const useShell = shell ?? (process.platform === "win32" ? true : "/bin/bash");
      const shellPath = typeof useShell === "string" ? useShell : "/bin/bash";

      // OS-level sandbox: in sandbox (multitenant) mode on macOS, run the shell
      // under sandbox-exec so the KERNEL confines its filesystem to the tenant's
      // allow-list. This closes the `ls ../../../../crew` / `cat /Users/...`
      // class that a string denylist cannot. Cloud runs each tenant in its own
      // Fly Machine, so there's no host FS to reach there.
      const allowRoots = Array.from(new Set([...(desc.allow ?? []), ...(desc.dataDir ? [desc.dataDir] : [])]));
      // Deny the trees that hold the host, the repo, and sibling tenants. On
      // macOS everything user-owned lives under /Users, so denying it (then
      // re-allowing the tenant's own dir) is a tight, reliable boundary.
      const denyRoots = Array.from(new Set(["/Users", process.env["HOME"] ?? ""].filter(Boolean)));
      const osSandbox = desc.mode === "sandbox" && process.platform === "darwin" && existsSync(SANDBOX_EXEC) && allowRoots.length > 0;
      if (desc.mode === "sandbox" && !osSandbox && process.platform !== "win32") {
        log.warn({ platform: process.platform }, "sandbox mode without an OS sandbox — shell is confined by denylist only; run tenants in a container for a real boundary");
      }

      // Sandbox mode → scrub the shell env so no secret leaks via `env`, and
      // point HOME at the tenant dir so tool caches (~/.npm, ~/.cache, …) land
      // INSIDE the workspace (writable + hidden from the file tree) instead of
      // failing against the real ~ (blocked) and getting dumped into the project.
      const sandboxHome = desc.dataDir ?? allowRoots[0];
      const childEnv = desc.mode === "sandbox"
        ? { ...safeShellEnv(), ...(sandboxHome ? { HOME: sandboxHome } : {}) }
        : process.env;

      return await new Promise<ExecResult>((resolvePromise, rejectPromise) => {
        const child = osSandbox
          ? spawn(SANDBOX_EXEC, ["-p", macSandboxProfile(allowRoots, denyRoots), shellPath, "-c", command], {
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              env: childEnv,
              stdio: ["ignore", "pipe", "pipe"],
              signal: abortSignal,
            })
          : spawn(command, {
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              env: childEnv,
              shell: useShell,
              stdio: ["ignore", "pipe", "pipe"],
              signal: abortSignal,
            });

        let stdout = "";
        let stderr = "";
        let truncated = false;

        const onData = (which: "out" | "err") => (chunk: Buffer) => {
          const buf = chunk.toString("utf-8");
          if (which === "out") {
            if (stdout.length + buf.length > maxOutputBytes) {
              stdout += buf.slice(0, Math.max(0, maxOutputBytes - stdout.length));
              truncated = true;
            } else {
              stdout += buf;
            }
          } else if (stderr.length + buf.length > maxOutputBytes) {
            stderr += buf.slice(0, Math.max(0, maxOutputBytes - stderr.length));
            truncated = true;
          } else {
            stderr += buf;
          }
        };

        child.stdout?.on("data", onData("out"));
        child.stderr?.on("data", onData("err"));

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref();
          rejectPromise(new TimeoutError(`execute_command (${command})`, timeoutMs));
        }, timeoutMs);
        timer.unref();

        child.once("error", (err) => {
          clearTimeout(timer);
          if (abortSignal.aborted) {
            rejectPromise(new ValidationError("Command cancelled"));
            return;
          }
          rejectPromise(err);
        });

        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolvePromise({
            stdout,
            stderr,
            exitCode,
            signal,
            truncated,
            durationMs: Date.now() - started,
          });
        });
      });
    },
  };
}
