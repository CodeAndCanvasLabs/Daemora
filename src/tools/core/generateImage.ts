import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderUnavailableError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

/**
 * Provider-agnostic image generation. Resolution order:
 *
 *   1. Caller passes `provider` + `model` directly → use them.
 *   2. Caller passes only `model` → infer provider from configured keys.
 *   3. IMAGE_GEN_MODEL setting holds "provider:model" → use that.
 *   4. Auto-pick: vertex (Express) → google → openai → fail.
 *
 * Each provider routes to its own REST surface. Output is always
 * saved as PNG to <dataDir>/outputs/ so the chat UI renders inline.
 */

const PROVIDERS = ["openai", "vertex", "google"] as const;
type ImageProvider = (typeof PROVIDERS)[number];

const inputSchema = z.object({
  prompt: z.string().min(1).max(4000).describe("Image description."),
  provider: z.enum(PROVIDERS).optional().describe(
    "DO NOT SET. Provider auto-picks from the IMAGE_GEN_MODEL setting; only override if you have a specific reason.",
  ),
  model: z.string().optional().describe(
    "DO NOT SET. Model auto-picks from the IMAGE_GEN_MODEL setting.",
  ),
  size: z.string().optional().describe("Aspect / dimensions, provider-specific."),
  outputPath: z.string().optional(),
});

export function makeGenerateImageTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { path: string; provider: ImageProvider; model: string }> {
  return {
    name: "generate_image",
    description:
      "Generate an image from text. Pass ONLY `prompt` and (optionally) `outputPath` / `size`. Provider and model are configured in settings — do not pass them. Returns the saved PNG path.",
    category: "ai",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["image", "generate", "art", "gemini", "imagen", "dalle", "nano-banana"],
    inputSchema,
    async execute({ prompt, provider, model, size, outputPath }) {
      const resolved = resolveProviderAndModel(cfg, provider, model);
      const apiKey = cfg.vault.get(resolved.keyName)?.reveal();
      if (!apiKey) throw new ProviderUnavailableError(resolved.provider, resolved.keyName);

      const png = await generate(resolved.provider, resolved.model, apiKey, prompt, size);

      let path = outputPath;
      if (!path) {
        const outDir = join(cfg.env.dataDir, "outputs");
        await mkdir(outDir, { recursive: true });
        path = join(outDir, `daemora-image-${Date.now()}.png`);
      }
      await writeFile(path, png);
      return { path, provider: resolved.provider, model: resolved.model };
    },
  };
}

interface Resolved {
  readonly provider: ImageProvider;
  readonly model: string;
  readonly keyName: string;
}

function resolveProviderAndModel(
  cfg: ConfigManager,
  provider: ImageProvider | undefined,
  model: string | undefined,
): Resolved {
  // 1. Explicit provider wins.
  if (provider) {
    return {
      provider,
      model: model ?? defaultModelFor(provider),
      keyName: keyNameFor(provider),
    };
  }

  // 2. IMAGE_GEN_MODEL setting (format: "provider:model").
  const setting = (cfg.setting("IMAGE_GEN_MODEL") as string | undefined) ?? undefined;
  if (setting && setting.includes(":")) {
    const [p, ...rest] = setting.split(":");
    if (PROVIDERS.includes(p as ImageProvider)) {
      return {
        provider: p as ImageProvider,
        model: model ?? rest.join(":"),
        keyName: keyNameFor(p as ImageProvider),
      };
    }
  }

  // 3. Auto-pick: prefer Vertex (Nano Banana on Express key) → Google AI → OpenAI.
  for (const p of PROVIDERS) {
    if (cfg.vault.get(keyNameFor(p)) !== undefined) {
      return { provider: p, model: model ?? defaultModelFor(p), keyName: keyNameFor(p) };
    }
  }

  throw new ProviderUnavailableError(
    "No image generation provider configured. Set GOOGLE_VERTEX_API_KEY, GOOGLE_AI_API_KEY, or OPENAI_API_KEY.",
  );
}

function keyNameFor(provider: ImageProvider): string {
  switch (provider) {
    case "openai": return "OPENAI_API_KEY";
    case "google": return "GOOGLE_AI_API_KEY";
    case "vertex": return "GOOGLE_VERTEX_API_KEY";
  }
}

function defaultModelFor(provider: ImageProvider): string {
  switch (provider) {
    case "openai": return "dall-e-3";
    case "google": return "gemini-2.5-flash-image";
    case "vertex": return "gemini-2.5-flash-image";
  }
}

async function generate(
  provider: ImageProvider,
  model: string,
  apiKey: string,
  prompt: string,
  size: string | undefined,
): Promise<Buffer> {
  if (provider === "openai") return generateOpenAI(model, apiKey, prompt, size ?? "1024x1024");
  if (provider === "google") return generateGemini("https://generativelanguage.googleapis.com/v1beta", model, apiKey, prompt);
  // vertex express — same Gemini :generateContent shape, different host.
  return generateGemini("https://aiplatform.googleapis.com/v1beta1", `publishers/google/models/${model}`, apiKey, prompt);
}

async function generateOpenAI(model: string, apiKey: string, prompt: string, size: string): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size, n: 1, response_format: "b64_json" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`OpenAI image ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { b64_json: string }[] };
  const b64 = data.data[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data");
  return Buffer.from(b64, "base64");
}

/**
 * Gemini image gen via :generateContent — works for both Google AI
 * (generativelanguage.googleapis.com) and Vertex Express
 * (aiplatform.googleapis.com). Both expect the same body shape and
 * return inline_data parts. The model path differs: Google AI uses
 * `models/{name}`, Vertex uses `publishers/google/models/{name}`.
 */
async function generateGemini(baseUrl: string, modelPath: string, apiKey: string, prompt: string): Promise<Buffer> {
  const url = `${baseUrl}/${modelPath.includes("/") ? modelPath : `models/${modelPath}`}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Gemini image ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data: string; mimeType: string } }> };
    }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data);
  if (!inline?.inlineData) throw new Error("Gemini returned no image inline_data");
  return Buffer.from(inline.inlineData.data, "base64");
}
