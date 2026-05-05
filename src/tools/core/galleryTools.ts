/**
 * Gallery tools — surface the user's reference library to the agent.
 *
 * Pattern:
 *   - `list_gallery_projects` (alwaysOn) returns every project plus
 *     inlined image filers, capped at ~8k tokens of filer content so a
 *     gallery-heavy user doesn't blow the context window.
 *
 * The agent calls this whenever the user mentions a brand, a saved
 * asset, or anything that sounds like "use my X" — the response gives
 * the agent file paths it can then load via `read_file` / `read_pdf`.
 *
 * Crews / sub-agents inherit this tool through the core registry, so
 * the same flow works inside delegated work.
 */

import { z } from "zod";

import { formatAllGalleryProjects } from "../../files/projectContext.js";
import type { FileProjectStore } from "../../files/FileProjectStore.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({});

export function makeListGalleryProjectsTool(
  store: FileProjectStore,
): ToolDef<typeof inputSchema, { manifest: string; projectCount: number }> {
  return {
    name: "list_gallery_projects",
    description: [
      "List the user's gallery projects — curated reference folders of brand assets,",
      "logos, guidelines, screenshots, and source files dropped into the Gallery UI.",
      "Returns each project's files (with absolute paths) and inlined descriptions of",
      "every image. Call this whenever the user mentions a brand or saved asset, or",
      "before generating derivative work (videos, slides, posts) so you can adhere to",
      "their visual identity. Pair with `read_file` / `read_pdf` to load file contents.",
      "When delegating to crews, pass `references: [\"gallery:<slug>\"]` so the sub-agent",
      "automatically receives the same project context.",
    ].join(" "),
    category: "core",
    source: { kind: "core" },
    alwaysOn: true,
    tags: ["gallery", "files", "reference", "brand"],
    inputSchema,
    async execute() {
      const manifest = formatAllGalleryProjects(store);
      const projectCount = store.list().length;
      return { manifest, projectCount };
    },
  };
}
