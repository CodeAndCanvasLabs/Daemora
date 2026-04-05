/**
 * generateImage - Generate images using OpenAI DALL-E 3 or DALL-E 2.
 * Saves the image to /tmp and returns the file path for the agent to use.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";

export async function generateImage(params) {
  const prompt = params?.prompt;
  if (!prompt) return "Error: prompt is required.";

  const opts = _mergeLegacyOpts(params, ["prompt"]);

  const {
    model = "dall-e-3",
    size = "1024x1024",
    quality = "standard",
    style = "vivid",
    n = 1,
    outputPath = null,
  } = opts;

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) return "Error: OPENAI_API_KEY not configured.";

  const body = { model, prompt, n: Math.min(n, model === "dall-e-3" ? 1 : 10), size, response_format: "b64_json" };
  if (model === "dall-e-3") {
    body.quality = quality;
    body.style = style;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) return `Error: ${data.error?.message || res.status}`;

    const images = data.data || [];
    if (images.length === 0) return "Error: No images returned.";

    const saved = [];
    const dir = getTenantTmpDir("daemora-images");

    for (let i = 0; i < images.length; i++) {
      const b64 = images[i].b64_json;
      const revised = images[i].revised_prompt || prompt;
      const filePath = outputPath || join(dir, `image-${Date.now()}-${i}.png`);
      if (outputPath) {
        const wc = filesystemGuard.checkWrite(outputPath);
        if (!wc.allowed) return `Error: ${wc.reason}`;
      }
      writeFileSync(filePath, Buffer.from(b64, "base64"));
      saved.push({ path: filePath, revisedPrompt: revised });
    }

    const lines = saved.map(s =>
      `Saved: ${s.path}${s.revisedPrompt !== prompt ? `\nRevised prompt: ${s.revisedPrompt}` : ""}`
    );
    return `Generated ${saved.length} image(s):\n${lines.join("\n")}`;
  } catch (err) {
    return `Error generating image: ${err.message}`;
  }
}

export const generateImageDescription =
  `generateImage(prompt: string, optionsJson?: string) - Generate images with DALL-E.
  prompt: description of the image to generate
  optionsJson: {"model":"dall-e-3","size":"1024x1024","quality":"standard","style":"vivid","n":1,"outputPath":"/tmp/out.png"}
  model: "dall-e-3" (default, best quality) or "dall-e-2"
  size: "1024x1024" | "1792x1024" | "1024x1792" (dall-e-3) or "256x256"|"512x512"|"1024x1024" (dall-e-2)
  quality: "standard" | "hd" (dall-e-3 only)
  style: "vivid" | "natural" (dall-e-3 only)
  Returns the file path of the saved image.`;
