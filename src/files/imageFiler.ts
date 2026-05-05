/**
 * imageFiler — auto-generate a structured description of an image.
 *
 * Producer for the Files feature's `<file>.md` sidecars (project
 * "filers"). Returns a frontmatter-+-prose markdown string. Same call
 * shape is reused by `desktop.ts` for vision-click coordinate guesses.
 *
 * Provider chain (first that's configured wins):
 *   1. Vertex Gemini (LOCAL ONLY — comment out for customer release)
 *   2. OpenAI gpt-4o-mini
 *   3. Anthropic claude-haiku
 *
 * Replaces the old `image_analysis` agent tool, which was redundant —
 * native multimodal handles the in-chat case, and this internal helper
 * covers the file-scan + vision-click cases.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { ConfigManager } from "../config/ConfigManager.js";
import { ProviderUnavailableError } from "../util/errors.js";

export interface DescribeImageOpts {
  /** Override the prompt sent to the vision model. */
  readonly prompt?: string;
  /** Override the model id (only honoured for the Vertex path). */
  readonly model?: string;
}

export interface DescribeImageResult {
  /** The model's text response. Caller decides what to do with it. */
  readonly text: string;
  /** Which provider actually answered. */
  readonly provider: "vertex" | "google" | "openai" | "anthropic";
  /** Model id that produced the response. */
  readonly model: string;
}

const DEFAULT_PROMPT = "Describe this image in detail.";

const FILER_PROMPT = [
  "Analyse this image for use as a project asset reference. Reply with EXACTLY two parts:",
  "",
  "PART 1 — YAML frontmatter (between two `---` lines) with these keys:",
  "  kind: one of [logo, screenshot, photo, diagram, illustration, document_scan, ui_mockup, other]",
  "  dominantColors: array of 1-5 hex codes (e.g. [\"#a855f7\", \"#7c3aed\"])",
  "  textInImage: array of strings — every legible word/phrase you can read in the image. Empty array if none.",
  "  primarySubject: a short noun phrase describing the main visual element.",
  "",
  "PART 2 — A 60-150 word prose description below the closing `---`. Cover composition, style, typography (if any), notable details, and how this asset would typically be used.",
].join("\n");

function detectMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

/**
 * Run a vision model on `imagePath` and return the response.
 *
 * Used by:
 *   - The Files scan queue (passes `prompt: FILER_PROMPT`-equivalent).
 *   - desktop.ts vision-click (passes its own coordinate prompt).
 */
export async function describeImage(
  imagePath: string,
  cfg: ConfigManager,
  opts: DescribeImageOpts = {},
): Promise<DescribeImageResult> {
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString("base64");
  const mimeType = detectMime(imagePath);
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const ctx: VisionCallContext = { imageData, base64, mimeType, prompt };

  // ── Explicit user choice ──────────────────────────────────────
  // IMAGE_SCAN_MODEL wins (gallery-page picker). Empty falls back
  // to DEFAULT_MODEL (the main agent's model). If neither is set,
  // the legacy auto-chain below decides. opts.model is a caller
  // override (desktop vision-click) and only affects the Vertex
  // path for backward compatibility.
  const scanSetting = cfg.settings.get("IMAGE_SCAN_MODEL");
  const defaultSetting = cfg.settings.get("DEFAULT_MODEL");
  const chosen = opts.model ? null : (scanSetting ?? defaultSetting);
  if (chosen) {
    const colon = chosen.indexOf(":");
    if (colon > 0) {
      const provider = chosen.slice(0, colon);
      const model = chosen.slice(colon + 1);
      try {
        if (provider === "vertex" || provider === "vertex-anthropic") {
          return await callVertex(cfg, ctx, model);
        }
        if (provider === "google") {
          return await callGoogle(cfg, ctx, model);
        }
        if (provider === "openai") {
          return await callOpenAI(cfg, ctx, model);
        }
        if (provider === "anthropic") {
          return await callAnthropic(cfg, ctx, model);
        }
        console.warn(`[imageFiler] Unknown provider "${provider}", falling back to auto-chain.`);
      } catch (e) {
        console.warn(`[imageFiler] ${provider}:${model} failed (${(e as Error).message}); falling back.`);
      }
    }
  }

  // ── Legacy auto-chain ─────────────────────────────────────────
  // LOCAL ONLY — Vertex Gemini first when its env vars are set.
  // Customer installs (no env vars) skip straight to OpenAI/Anthropic.
  const vertexFallbackModel = opts.model
    ?? process.env["DAEMORA_IMAGE_ANALYSIS_MODEL"]
    ?? "gemini-3.1-flash-lite-preview";
  const vertexSaPath = process.env["DAEMORA_VERTEX_SA_KEY_PATH"] ?? "";
  const vertexProject = process.env["DAEMORA_VERTEX_PROJECT_ID"] ?? "";
  const vertexApiKey = cfg.vault.get("GOOGLE_VERTEX_API_KEY")?.reveal() ?? "";
  const hasSa = vertexSaPath && existsSync(vertexSaPath) && vertexProject;
  if (hasSa || vertexApiKey) {
    try {
      return await callVertex(cfg, ctx, vertexFallbackModel);
    } catch (e) {
      console.warn(`[imageFiler] Vertex auto-chain failed (${(e as Error).message}); falling back.`);
    }
  }

  const openaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
  if (openaiKey) return callOpenAI(cfg, ctx, "gpt-4o-mini");
  const anthropicKey = cfg.vault.get("ANTHROPIC_API_KEY")?.reveal();
  if (anthropicKey) return callAnthropic(cfg, ctx, "claude-haiku-4-5");
  throw new ProviderUnavailableError("Vision", "OPENAI_API_KEY or ANTHROPIC_API_KEY");
}

interface VisionCallContext {
  readonly imageData: Buffer;
  readonly base64: string;
  readonly mimeType: string;
  readonly prompt: string;
}

async function callVertex(
  cfg: ConfigManager,
  ctx: VisionCallContext,
  model: string,
): Promise<DescribeImageResult> {
  const vertexSaPath = process.env["DAEMORA_VERTEX_SA_KEY_PATH"] ?? "";
  const vertexProject = process.env["DAEMORA_VERTEX_PROJECT_ID"] ?? "";
  const vertexLocation = process.env["DAEMORA_VERTEX_GEMINI_LOCATION"] ?? "global";
  const vertexApiKey = cfg.vault.get("GOOGLE_VERTEX_API_KEY")?.reveal() ?? "";
  const hasSa = vertexSaPath && existsSync(vertexSaPath) && vertexProject;
  if (!hasSa && !vertexApiKey) {
    throw new ProviderUnavailableError("Vertex", "DAEMORA_VERTEX_SA_KEY_PATH or GOOGLE_VERTEX_API_KEY");
  }
  const { createVertex } = await import("@ai-sdk/google-vertex");
  const { generateText } = await import("ai");
  const vertex = hasSa
    ? createVertex({
        project: vertexProject,
        location: vertexLocation,
        googleAuthOptions: {
          keyFile: vertexSaPath,
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      })
    : createVertex({ apiKey: vertexApiKey });
  const result = await generateText({
    model: vertex(model),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: ctx.prompt },
        { type: "image", image: ctx.imageData, mediaType: ctx.mimeType },
      ],
    }],
    maxOutputTokens: 2000,
  });
  return { text: result.text, provider: "vertex", model };
}

async function callGoogle(
  cfg: ConfigManager,
  ctx: VisionCallContext,
  model: string,
): Promise<DescribeImageResult> {
  const apiKey = cfg.vault.get("GOOGLE_AI_API_KEY")?.reveal();
  if (!apiKey) throw new ProviderUnavailableError("Google AI", "GOOGLE_AI_API_KEY");
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const { generateText } = await import("ai");
  const google = createGoogleGenerativeAI({ apiKey });
  const result = await generateText({
    model: google(model),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: ctx.prompt },
        { type: "image", image: ctx.imageData, mediaType: ctx.mimeType },
      ],
    }],
    maxOutputTokens: 2000,
  });
  return { text: result.text, provider: "google", model };
}

async function callOpenAI(
  cfg: ConfigManager,
  ctx: VisionCallContext,
  model: string,
): Promise<DescribeImageResult> {
  const apiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
  if (!apiKey) throw new ProviderUnavailableError("OpenAI", "OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: ctx.prompt },
          { type: "image_url", image_url: { url: `data:${ctx.mimeType};base64,${ctx.base64}` } },
        ],
      }],
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return { text: data.choices[0]?.message?.content ?? "", provider: "openai", model };
}

async function callAnthropic(
  cfg: ConfigManager,
  ctx: VisionCallContext,
  model: string,
): Promise<DescribeImageResult> {
  const apiKey = cfg.vault.get("ANTHROPIC_API_KEY")?.reveal();
  if (!apiKey) throw new ProviderUnavailableError("Anthropic", "ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: ctx.mimeType, data: ctx.base64 } },
          { type: "text", text: ctx.prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { text: string }[] };
  return { text: data.content[0]?.text ?? "", provider: "anthropic", model };
}

/**
 * Build the project filer markdown for an image. Calls describeImage
 * with the structured-frontmatter prompt and returns a markdown body
 * ready to write to disk. Adds a small `scannedAt` / `model` footer to
 * the frontmatter so the scan can be re-run idempotently if desired.
 */
export async function buildImageFiler(
  imagePath: string,
  cfg: ConfigManager,
): Promise<string> {
  const result = await describeImage(imagePath, cfg, { prompt: FILER_PROMPT });
  const filename = imagePath.split("/").pop() ?? "image";
  const ext = extname(filename) || ".bin";
  const scannedAt = new Date().toISOString();
  const body = result.text.trim();

  // The model is instructed to produce frontmatter+prose in one shot.
  // If it complies, splice in scannedAt/model into the existing
  // frontmatter rather than wrapping it again.
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end > 0) {
      const fm = body.slice(0, end + 4);
      const rest = body.slice(end + 4);
      const injected = fm.replace(
        /\n---$/,
        `\nscannedAt: ${scannedAt}\nmodel: ${result.model}\nprovider: ${result.provider}\nfilename: ${filename}\n---`,
      );
      return `${injected}${rest}\n`;
    }
  }

  // Fallback — model didn't follow the format. Wrap the raw text.
  return [
    "---",
    `filename: ${filename}`,
    `extension: ${ext}`,
    `scannedAt: ${scannedAt}`,
    `model: ${result.model}`,
    `provider: ${result.provider}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}
