import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  path: z.string().min(1).describe("File to patch."),
  patch: z.string().min(1).describe("Unified diff or list of find→replace blocks. Each block: <<<FIND\\nold_text\\n===\\nnew_text\\n>>>"),
});

export function makeApplyPatchTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, { path: string; applied: number }> {
  return {
    name: "apply_patch",
    description: "Apply multiple find-and-replace edits to a file in one call. Each block: <<<FIND\\nold\\n===\\nnew\\n>>>. More efficient than multiple edit_file calls.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    destructive: true,
    inputSchema,
    async execute({ path, patch }) {
      const canonical = guard.ensureAllowed(path, "write");

      let content: string;
      try { content = await readFile(canonical, "utf-8"); }
      catch { throw new NotFoundError(`File not found: ${canonical}`); }

      const blocks = parsePatchBlocks(patch);
      if (blocks.length === 0) throw new ValidationError("No patch blocks found. Use <<<FIND\\nold\\n===\\nnew\\n>>> format.");

      let applied = 0;
      for (const { find, replace } of blocks) {
        if (!content.includes(find)) {
          throw new ValidationError(`Patch block not found in ${canonical}: ${find.slice(0, 60)}...`);
        }
        content = content.replace(find, replace);
        applied++;
      }

      await writeFile(canonical, content, "utf-8");
      return { path: canonical, applied };
    },
  };
}

function parsePatchBlocks(patch: string): { find: string; replace: string }[] {
  const blocks: { find: string; replace: string }[] = [];
  const regex = /<<<FIND\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>/g;
  let m;
  while ((m = regex.exec(patch)) !== null) {
    blocks.push({ find: m[1]!, replace: m[2]! });
  }
  return blocks;
}
