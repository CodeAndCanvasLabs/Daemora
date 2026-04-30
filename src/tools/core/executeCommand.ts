import { spawn } from "node:child_process";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { TimeoutError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

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

      const started = Date.now();
      const useShell = shell ?? (process.platform === "win32" ? true : "/bin/bash");

      return await new Promise<ExecResult>((resolvePromise, rejectPromise) => {
        const child = spawn(command, {
          ...(cwd ? { cwd } : {}),
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
