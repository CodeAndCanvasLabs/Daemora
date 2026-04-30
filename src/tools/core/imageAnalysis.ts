import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderUnavailableError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  imagePath: z.string().min(1).describe("Path to the image file."),
  prompt: z.string().default("Describe this image in detail.").describe("What to analyze about the image."),
});

export function makeImageAnalysisTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { analysis: string }> {
  return {
    name: "image_analysis",
    description: "Analyze an image using a vision model. Supports PNG, JPG, GIF, WebP.",
    category: "ai",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["vision", "image", "screenshot", "analyze"],
    inputSchema,
    async execute({ imagePath, prompt }) {
      const apiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal()
        ?? cfg.vault.get("ANTHROPIC_API_KEY")?.reveal();
      if (!apiKey) throw new ProviderUnavailableError("Vision", "OPENAI_API_KEY or ANTHROPIC_API_KEY");

      const imageData = await readFile(imagePath);
      const base64 = imageData.toString("base64");
      const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

      // Use OpenAI vision API
      const useOpenAI = !!cfg.vault.get("OPENAI_API_KEY");
      if (useOpenAI) {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
              ],
            }],
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Vision API ${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { choices: { message: { content: string } }[] };
        return { analysis: data.choices[0]?.message?.content ?? "" };
      }

      // Anthropic vision
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250506",
          max_tokens: 2000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Vision API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content: { text: string }[] };
      return { analysis: data.content[0]?.text ?? "" };
    },
  };
}
