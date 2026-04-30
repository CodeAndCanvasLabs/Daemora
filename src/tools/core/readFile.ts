import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative file path"),
  /** Optional read window for large files. */
  startLine: z.number().int().min(1).optional().describe("1-based start line, optional"),
  endLine: z.number().int().min(1).optional().describe("1-based end line (inclusive), optional"),
  /** Hard cap so an LLM can't blow context by reading a huge file. */
  maxBytes: z.number().int().positive().max(1_000_000).default(200_000),
});

export function makeReadFileTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, string> {
  return {
    name: "read_file",
    description: "Read a text file. Use startLine/endLine for large files. 200 KB hard cap by default.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ path, startLine, endLine, maxBytes }) {
      const canonical = guard.ensureAllowed(path, "read");

      let s;
      try {
        s = await stat(canonical);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new NotFoundError(`File not found: ${canonical}`);
        if (err.code === "EACCES") throw new PermissionDeniedError(`Read denied: ${canonical}`);
        throw err;
      }
      if (!s.isFile()) throw new ValidationError(`Not a file: ${canonical}`);

      if (s.size > maxBytes && !startLine && !endLine) {
        throw new ValidationError(
          `File ${canonical} is ${s.size} bytes — exceeds maxBytes (${maxBytes}). Pass startLine/endLine to read a window.`,
        );
      }

      const raw = await readFile(canonical, "utf-8");
      if (startLine === undefined && endLine === undefined) return raw;

      const lines = raw.split("\n");
      const a = Math.max(0, (startLine ?? 1) - 1);
      const b = Math.min(lines.length, endLine ?? lines.length);
      return lines.slice(a, b).join("\n");
    },
  };
}
