import { z } from "zod";
import { spawn } from "node:child_process";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  pattern: z.string().min(1).describe("Regex pattern to search for."),
  path: z.string().default(".").describe("File or directory to search in."),
  include: z.string().optional().describe("Glob to filter files (e.g. '*.ts')."),
  ignoreCase: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(500).default(100),
  contextLines: z.number().int().min(0).max(10).default(0),
});

export function makeGrepTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, { matches: string; matchCount: number; truncated: boolean }> {
  return {
    name: "grep",
    description: "Search file contents with regex. Uses ripgrep if available, falls back to grep. Returns matching lines with file:line references.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ pattern, path, include, ignoreCase, maxResults, contextLines }, { abortSignal }) {
      const canonical = guard.ensureAllowed(path, "read");

      // Prefer rg (ripgrep) > grep
      const useRg = await commandExists("rg");
      const args: string[] = [];

      if (useRg) {
        args.push("rg", "--no-heading", "--line-number", "--color=never");
        if (ignoreCase) args.push("-i");
        if (contextLines > 0) args.push(`-C${contextLines}`);
        if (include) args.push(`--glob=${include}`);
        args.push(`--max-count=${maxResults}`, pattern, canonical);
      } else {
        args.push("grep", "-rn", "--color=never");
        if (ignoreCase) args.push("-i");
        if (contextLines > 0) args.push(`-C${contextLines}`);
        if (include) args.push(`--include=${include}`);
        args.push(pattern, canonical);
      }

      const cmd = args[0]!;
      const cmdArgs = args.slice(1);

      return new Promise((resolve) => {
        let output = "";
        let truncated = false;
        const maxBytes = 200_000;

        const child = spawn(cmd, cmdArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          signal: abortSignal,
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          if (output.length < maxBytes) {
            output += chunk.toString("utf-8");
          } else {
            truncated = true;
          }
        });
        child.stderr?.on("data", () => { /* swallow */ });

        child.once("close", () => {
          const lines = output.trim().split("\n").filter(Boolean);
          const matchCount = Math.min(lines.length, maxResults);
          const trimmed = lines.slice(0, maxResults).join("\n");
          resolve({ matches: trimmed, matchCount, truncated });
        });

        child.once("error", () => {
          resolve({ matches: "", matchCount: 0, truncated: false });
        });
      });
    },
  };
}

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.once("close", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}
