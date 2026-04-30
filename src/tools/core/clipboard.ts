import { execSync } from "node:child_process";
import { z } from "zod";

import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum(["read", "write"]),
  text: z.string().optional().describe("Text to write to clipboard (required for write)."),
});

export const clipboardTool: ToolDef<typeof inputSchema, { text: string }> = {
  name: "clipboard",
  description: "Read or write the system clipboard.",
  category: "system",
  source: { kind: "core" },
  alwaysOn: false,
  tags: ["clipboard", "copy", "paste"],
  inputSchema,
  async execute({ action, text }) {
    if (action === "write") {
      if (!text) throw new Error("text is required for clipboard write");
      if (process.platform === "darwin") {
        execSync("pbcopy", { input: text, timeout: 5000 });
      } else {
        execSync("xclip -selection clipboard", { input: text, timeout: 5000 });
      }
      return { text: `Copied ${text.length} chars to clipboard` };
    }

    // read
    let result: string;
    if (process.platform === "darwin") {
      result = execSync("pbpaste", { encoding: "utf-8", timeout: 5000 }).trim();
    } else {
      result = execSync("xclip -selection clipboard -o", { encoding: "utf-8", timeout: 5000 }).trim();
    }
    return { text: result };
  },
};
