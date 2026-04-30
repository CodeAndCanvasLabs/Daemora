import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  outputPath: z.string().optional().describe("Where to save. Defaults to temp dir."),
  display: z.number().int().default(1).describe("Display number (multi-monitor). Default 1."),
});

export const screenCaptureTool: ToolDef<typeof inputSchema, { path: string }> = {
  name: "screen_capture",
  description: "Take a screenshot of the current screen. macOS uses screencapture, Linux uses import/scrot.",
  category: "system",
  source: { kind: "core" },
  alwaysOn: false,
  tags: ["screenshot", "screen", "capture"],
  inputSchema,
  async execute({ outputPath, display }) {
    const path = outputPath ?? join(tmpdir(), `daemora-screenshot-${Date.now()}.png`);

    return new Promise((resolve, reject) => {
      const args = process.platform === "darwin"
        ? ["screencapture", "-x", `-D${display}`, path]
        : ["import", "-window", "root", path]; // ImageMagick on Linux

      const child = spawn(args[0]!, args.slice(1), { stdio: "ignore" });
      child.once("close", (code) => {
        if (code === 0) resolve({ path });
        else reject(new Error(`Screen capture failed (exit ${code})`));
      });
      child.once("error", (e) => reject(e));
    });
  },
};
