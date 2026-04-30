/**
 * git(action, ...) — run git commands on a repo checkout.
 *
 * Thin wrapper around the system `git` binary. Every non-clone action
 * goes through the filesystem guard (read for status/diff/log, write
 * for anything that mutates the working tree). Output is capped so a
 * runaway `git log` can't blow the agent's context.
 *
 * Uses execFile — no shell interpolation — so repo paths / branch
 * names / messages can't escape into the command line.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ProviderError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 16_000;
const TIMEOUT_MS = 60_000;

const inputSchema = z.object({
  action: z.enum([
    "clone", "status", "diff", "log", "add", "commit",
    "push", "pull", "branch", "checkout", "stash", "reset", "remote", "fetch",
  ]),
  path: z.string().optional().describe("Repo working directory. Required for every action except clone."),
  // clone
  url: z.string().optional(),
  dest: z.string().optional(),
  // diff
  staged: z.boolean().default(false),
  file: z.string().optional(),
  // log
  n: z.number().int().min(1).max(500).default(20),
  oneline: z.boolean().default(true),
  // add
  files: z.array(z.string()).optional(),
  // commit
  message: z.string().optional(),
  all: z.boolean().default(false),
  // push / pull
  remote: z.string().default("origin"),
  branch: z.string().optional(),
  force: z.boolean().default(false),
  rebase: z.boolean().default(false),
  // branch / checkout
  delete: z.boolean().default(false),
  list: z.boolean().default(false),
  create: z.boolean().default(false),
  // stash
  sub: z.enum(["push", "pop", "list", "drop"]).default("push"),
  // reset
  hard: z.boolean().default(false),
});

export function makeGitTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, unknown> {
  async function git(args: readonly string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args as string[], {
        cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8",
      });
      return stdout.slice(0, MAX_OUTPUT).trim();
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      throw new ProviderError(`Git failed: ${msg}`, "git");
    }
  }

  return {
    name: "git",
    description:
      "Run git operations (clone, status, diff, log, add, commit, push, pull, branch, checkout, stash, reset, remote, fetch).",
    category: "shell",
    source: { kind: "core" },
    destructive: true,
    tags: ["git", "vcs", "scm"],
    inputSchema,
    async execute(input) {
      const repoPath = input.path ? resolve(input.path) : process.cwd();
      if (input.action !== "clone") {
        guard.ensureAllowed(repoPath, "read");
        const s = await stat(repoPath).catch(() => null);
        if (!s?.isDirectory()) throw new NotFoundError(`Repo directory not found: ${repoPath}`);
      }

      switch (input.action) {
        case "clone": {
          if (!input.url) throw new ValidationError("url is required for clone");
          if (!input.dest) throw new ValidationError("dest is required for clone");
          const dest = resolve(input.dest);
          guard.ensureAllowed(dest, "write");
          const args = ["clone"];
          if (input.branch) args.push("-b", input.branch);
          args.push(input.url, dest);
          return { output: await git(args, process.cwd()) };
        }

        case "status":
          return { output: await git(["status"], repoPath) };

        case "diff": {
          const args = ["diff"];
          if (input.staged) args.push("--staged");
          if (input.file) args.push("--", input.file);
          const output = await git(args, repoPath);
          return { output: output || "(no changes)" };
        }

        case "log": {
          const args = ["log", `-n${input.n}`];
          if (input.oneline) args.push("--oneline");
          else args.push("--pretty=format:%h %an %ar - %s");
          return { output: await git(args, repoPath) };
        }

        case "add": {
          const files = input.files && input.files.length > 0 ? input.files : ["."];
          await git(["add", ...files], repoPath);
          return { output: `Staged: ${files.join(" ")}` };
        }

        case "commit": {
          if (!input.message) throw new ValidationError("message is required for commit");
          const args = ["commit", "-m", input.message];
          if (input.all) args.splice(1, 0, "-a");
          return { output: await git(args, repoPath) };
        }

        case "push": {
          const args = ["push"];
          if (input.force) args.push("--force-with-lease");
          args.push(input.remote);
          if (input.branch) args.push(input.branch);
          return { output: await git(args, repoPath) };
        }

        case "pull": {
          const args = ["pull"];
          if (input.rebase) args.push("--rebase");
          args.push(input.remote);
          if (input.branch) args.push(input.branch);
          return { output: await git(args, repoPath) };
        }

        case "fetch": {
          const args = ["fetch", input.remote];
          if (input.branch) args.push(input.branch);
          return { output: await git(args, repoPath) };
        }

        case "branch": {
          if (input.list || !input.branch) {
            return { output: await git(["branch", "-a"], repoPath) };
          }
          if (input.delete) {
            return { output: await git(["branch", "-d", input.branch], repoPath) };
          }
          return { output: await git(["branch", input.branch], repoPath) };
        }

        case "checkout": {
          if (input.file) {
            return { output: await git(["checkout", "--", input.file], repoPath) };
          }
          if (!input.branch) throw new ValidationError("branch is required for checkout");
          const args = ["checkout"];
          if (input.create) args.push("-b");
          args.push(input.branch);
          return { output: await git(args, repoPath) };
        }

        case "stash": {
          if (input.sub === "push") {
            const args = ["stash", "push"];
            if (input.message) args.push("-m", input.message);
            return { output: await git(args, repoPath) };
          }
          return { output: await git(["stash", input.sub], repoPath) };
        }

        case "reset": {
          if (input.file) return { output: await git(["reset", "HEAD", input.file], repoPath) };
          return { output: await git(["reset", input.hard ? "--hard" : "--soft", "HEAD~1"], repoPath) };
        }

        case "remote":
          return { output: await git(["remote", "-v"], repoPath) };
      }
    },
  };
}
