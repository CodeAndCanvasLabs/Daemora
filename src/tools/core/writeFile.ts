import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { PermissionDeniedError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** If false (default), refuse to overwrite an existing file. */
  overwrite: z.boolean().default(false),
  /** Create parent directories if missing. Default true — agent shouldn't have to mkdir manually. */
  mkdirp: z.boolean().default(true),
});

export function makeWriteFileTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, { bytes: number; path: string }> {
  return {
    name: "write_file",
    description: "Write text to a file. Refuses to overwrite by default — pass overwrite:true to replace.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    destructive: true,
    inputSchema,
    async execute({ path, content, overwrite, mkdirp }) {
      const canonical = guard.ensureAllowed(path, "write");

      if (mkdirp) {
        try {
          await mkdir(dirname(canonical), { recursive: true });
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === "EACCES") throw new PermissionDeniedError(`Cannot create directory: ${dirname(canonical)}`);
          throw err;
        }
      }

      try {
        await writeFile(canonical, content, { encoding: "utf-8", flag: overwrite ? "w" : "wx" });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          throw new ValidationError(`Refusing to overwrite ${canonical} (pass overwrite:true to allow).`);
        }
        if (err.code === "EACCES") throw new PermissionDeniedError(`Write denied: ${canonical}`);
        throw err;
      }

      return { bytes: Buffer.byteLength(content, "utf-8"), path: canonical };
    },
  };
}
