/**
 * generate_video — text-to-video. Routes to:
 *   - openai:sora                via /v1/videos (poll /v1/videos/{id})
 *   - google:veo-*               via Gemini Developer API :predictLongRunning (API-key auth)
 *   - vertex:veo-*               via Vertex AI:
 *       - SA path (DAEMORA-VERTEX-SA TEMP): hardcoded constants below
 *       - API-key fallback: aiplatform.googleapis.com Express (typically 400s for Veo)
 *
 * Provider/model resolution mirrors generate_image:
 *   1. explicit `provider` param
 *   2. VIDEO_GEN_MODEL setting ("provider:model")
 *   3. auto-pick order: vertex SA → google → openai
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { ProviderError, ProviderUnavailableError, TimeoutError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 600_000; // Veo runs longer than Sora; 10 min cap.

// ── DAEMORA-VERTEX-SA — opt-in via env ─────────────────────────────────────
// Set DAEMORA_VERTEX_SA_KEY_PATH + DAEMORA_VERTEX_PROJECT_ID to enable Veo
// generation through a Service Account. When either is unset, the SA branch
// reports unavailable and Veo dispatches via the regular providers (OpenAI
// Sora, Google Generative).
const VERTEX_SA_PROJECT_ID = process.env["DAEMORA_VERTEX_PROJECT_ID"] ?? "";
const VERTEX_SA_LOCATION = process.env["DAEMORA_VERTEX_LOCATION"] ?? "us-central1";
const VERTEX_SA_KEY_PATH = process.env["DAEMORA_VERTEX_SA_KEY_PATH"] ?? "";
const VERTEX_SA_ENABLED = Boolean(VERTEX_SA_PROJECT_ID && VERTEX_SA_KEY_PATH);
// ── End DAEMORA-VERTEX-SA ──────────────────────────────────────────────────

const PROVIDERS = ["google", "openai", "vertex"] as const;
type VideoProvider = (typeof PROVIDERS)[number];

const inputSchema = z.object({
  prompt: z.string().min(1).max(2000),
  provider: z.enum(PROVIDERS).optional().describe(
    "DO NOT SET. Provider auto-picks from VIDEO_GEN_MODEL.",
  ),
  model: z.string().optional().describe(
    "DO NOT SET. Model auto-picks from VIDEO_GEN_MODEL.",
  ),
  duration: z.number().int().min(1).max(60).default(8),
  size: z.enum(["480p", "720p", "1080p"]).default("1080p"),
  style: z.enum(["natural", "vivid"]).default("natural"),
  outputPath: z.string().optional(),
});

interface OpenAiAsset { url?: string; b64_json?: string }

export function makeGenerateVideoTool(cfg: ConfigManager, guard: FilesystemGuard): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "generate_video",
    description:
      "Generate a video from a text prompt. Pass ONLY `prompt` and (optionally) `outputPath` / `duration` / `size`. Provider and model are configured in VIDEO_GEN_MODEL — do not pass them. Returns saved file path.",
    category: "ai",
    source: { kind: "core" },
    destructive: false,
    tags: ["video", "generation", "veo", "sora", "media"],
    inputSchema,
    async execute({ prompt, provider, model, duration, size, style, outputPath }, { abortSignal, logger }) {
      const resolved = resolveProviderAndModel(cfg, provider, model);

      // DAEMORA-VERTEX-SA — TEMP: SA path uses hardcoded constants above.
      if (resolved.provider === "vertex" && VERTEX_SA_ENABLED) {
        return runVertexVeoSA(resolved.model, prompt, outputPath, guard, abortSignal, logger);
      }

      const apiKey = cfg.vault.get(resolved.keyName)?.reveal();
      if (!apiKey) throw new ProviderUnavailableError(resolved.provider, resolved.keyName);

      if (resolved.provider === "openai") {
        return runSora(apiKey, resolved.model, prompt, duration, size, style, outputPath, guard, abortSignal, logger);
      }
      if (resolved.provider === "vertex") {
        return runVertexVeo(apiKey, resolved.model, prompt, outputPath, guard, abortSignal, logger);
      }
      return runVeo(apiKey, resolved.model, prompt, outputPath, guard, abortSignal, logger);
    },
  };
}

interface Resolved { readonly provider: VideoProvider; readonly model: string; readonly keyName: string }

function resolveProviderAndModel(
  cfg: ConfigManager,
  provider: VideoProvider | undefined,
  model: string | undefined,
): Resolved {
  if (provider) {
    return { provider, model: model ?? defaultModelFor(provider), keyName: keyNameFor(provider) };
  }

  const setting = (cfg.setting("VIDEO_GEN_MODEL") as string | undefined) ?? undefined;
  if (setting && setting.includes(":")) {
    const [p, ...rest] = setting.split(":");
    if (PROVIDERS.includes(p as VideoProvider)) {
      return {
        provider: p as VideoProvider,
        model: model ?? rest.join(":"),
        keyName: keyNameFor(p as VideoProvider),
      };
    }
  }

  // DAEMORA-VERTEX-SA — TEMP: prefer Vertex SA path when enabled (skips vault key check).
  if (VERTEX_SA_ENABLED) {
    return { provider: "vertex", model: model ?? defaultModelFor("vertex"), keyName: keyNameFor("vertex") };
  }

  for (const p of PROVIDERS) {
    if (cfg.vault.get(keyNameFor(p)) !== undefined) {
      return { provider: p, model: model ?? defaultModelFor(p), keyName: keyNameFor(p) };
    }
  }

  throw new ProviderUnavailableError(
    "No video generation provider configured. Set GOOGLE_AI_API_KEY (Veo via Gemini API) or OPENAI_API_KEY (Sora). Or enable VERTEX_SA_ENABLED constant for Vertex SA paid path.",
  );
}

function keyNameFor(provider: VideoProvider): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "vertex") return "GOOGLE_VERTEX_API_KEY";
  return "GOOGLE_AI_API_KEY";
}
function defaultModelFor(provider: VideoProvider): string {
  if (provider === "openai") return "sora";
  // Gemini Developer API uses `-preview` for 3.1, `-001` for 3.0/2.0.
  // Default to the fast stable model so the call doesn't 404 on preview gates.
  return "veo-3.0-fast-generate-001";
}

// ── OpenAI Sora 2 ──────────────────────────────────────────────

/**
 * Sora 2 Videos API.
 *   Submit:   POST   /v1/videos                 → returns { id, status }
 *   Status:   GET    /v1/videos/{id}            → { status: queued|in_progress|completed|failed }
 *   Download: GET    /v1/videos/{id}/content    → mp4 bytes
 *
 * Body shape: { model, prompt, size: "WxH", seconds: "8" }.
 * Note: sora-2 (base) tops out at 1280x720; sora-2-pro is required for 1080x1920.
 * If caller asks for 1080p with the base model, auto-bump to sora-2-pro.
 *
 * (Endpoint deprecated by OpenAI on 2026-09-24 — when that hits, switch.)
 */
const SORA_SIZE_MAP: Record<string, string> = {
  "480p": "480x854",
  "720p": "720x1280",
  "1080p": "1080x1920",
};

async function runSora(
  key: string,
  model: string,
  prompt: string,
  duration: number,
  size: string,
  _style: string,
  outputPath: string | undefined,
  guard: FilesystemGuard,
  abortSignal: AbortSignal,
  logger: { info: (msg: string, ctx?: object) => void },
): Promise<unknown> {
  const sizeWxH = SORA_SIZE_MAP[size] ?? "1080x1920";
  const finalModel = (size === "1080p" && model === "sora-2") ? "sora-2-pro" : model;

  const submit = await fetch("https://api.openai.com/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: finalModel,
      prompt,
      size: sizeWxH,
      seconds: String(duration),
    }),
    signal: abortSignal,
  });
  const submitText = await submit.text();
  if (!submit.ok) {
    if (submit.status === 404 || submit.status === 403) {
      throw new ProviderError(
        `OpenAI Sora ${submit.status}: video generation not enabled for this OpenAI account. Sora API access requires a paid OpenAI account with Sora rolled out. ${submitText.slice(0, 300)}`,
        "openai",
      );
    }
    throw new ProviderError(`OpenAI Sora submit ${submit.status}: ${submitText.slice(0, 400)}`, "openai");
  }
  let submitData: { id?: string; status?: string; error?: { message?: string } };
  try { submitData = JSON.parse(submitText); } catch { submitData = {}; }
  const videoId = submitData.id;
  if (!videoId) throw new ProviderError(`Sora submit missing id: ${submitText.slice(0, 200)}`, "openai");
  logger.info("generate_video polling Sora", { videoId, model: finalModel });

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    if (abortSignal.aborted) throw new TimeoutError("generate_video cancelled", 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`https://api.openai.com/v1/videos/${videoId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: abortSignal,
    });
    if (!pollRes.ok) continue;
    const pollData = (await pollRes.json()) as {
      status?: string; error?: { message?: string };
    };
    if (pollData.status === "completed") {
      const dl = await fetch(`https://api.openai.com/v1/videos/${videoId}/content`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: abortSignal,
      });
      if (!dl.ok) {
        throw new ProviderError(`Sora download ${dl.status}: ${(await dl.text()).slice(0, 200)}`, "openai");
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      const saved = await saveBuffer(buf, outputPath, guard);
      return { path: saved, provider: "openai", model: finalModel, videoId };
    }
    if (pollData.status === "failed") {
      throw new ProviderError(`Sora failed: ${pollData.error?.message ?? "unknown"}`, "openai");
    }
  }
  throw new TimeoutError(`generate_video sora videoId=${videoId}`, MAX_POLL_MS);
}

// ── Google Veo via Vertex AI Express (API-key auth) ────────────

/**
 * Veo on Vertex AI using Express-mode API-key auth. Endpoint shape:
 *   POST https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:predictLongRunning?key=KEY
 *
 * Vertex Express historically restricted Veo to service-account auth, so
 * this MAY 401 — caller (the agent) should fall through to the Gemini
 * Developer API path (`runVeo`) by configuring GOOGLE_AI_API_KEY.
 *
 * Operation polling: GET https://aiplatform.googleapis.com/v1/{operationName}?key=KEY
 */
async function runVertexVeo(
  key: string,
  model: string,
  prompt: string,
  outputPath: string | undefined,
  guard: FilesystemGuard,
  abortSignal: AbortSignal,
  logger: { info: (msg: string, ctx?: object) => void },
): Promise<unknown> {
  const submitUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`;
  const submit = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 },
    }),
    signal: abortSignal,
  });
  if (!submit.ok) {
    const body = (await submit.text()).slice(0, 400);
    if (submit.status === 401 || submit.status === 403 || (submit.status === 400 && body.includes("RESOURCE_PROJECT_INVALID"))) {
      throw new ProviderError(
        `Vertex Veo ${submit.status}: API-key auth is not supported for Veo on Vertex (Veo requires project-scoped URLs and Service-Account tokens). ` +
          `RESOLUTION: set GOOGLE_AI_API_KEY (free key from https://aistudio.google.com/app/apikey) and retry — auto-pick will fall through to the Gemini Developer API path which DOES support API-key auth for Veo. Original response: ${body}`,
        "vertex",
      );
    }
    throw new ProviderError(`Vertex Veo submit ${submit.status}: ${body}`, "vertex");
  }
  const op = (await submit.json()) as { name?: string };
  if (!op.name) throw new ProviderError(`Vertex Veo returned no operation name`, "vertex");
  logger.info("generate_video polling Vertex Veo", { operation: op.name, model });

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    if (abortSignal.aborted) throw new TimeoutError("generate_video cancelled", 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(
      `https://aiplatform.googleapis.com/v1/${op.name}?key=${encodeURIComponent(key)}`,
      { signal: abortSignal },
    );
    if (!pollRes.ok) continue;
    const pollData = (await pollRes.json()) as {
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        videos?: Array<{ uri?: string; bytesBase64Encoded?: string; gcsUri?: string }>;
        generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> };
      };
    };
    if (pollData.error) {
      throw new ProviderError(`Vertex Veo failed: ${pollData.error.message ?? "unknown"}`, "vertex");
    }
    if (pollData.done) {
      const sample = pollData.response?.videos?.[0]
        ?? pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
      if (!sample) {
        throw new ProviderError(
          `Vertex Veo finished but response shape unrecognized: ${JSON.stringify(pollData.response).slice(0, 300)}`,
          "vertex",
        );
      }
      let buf: Buffer;
      const sAny = sample as { uri?: string; bytesBase64Encoded?: string };
      if (sAny.bytesBase64Encoded) {
        buf = Buffer.from(sAny.bytesBase64Encoded, "base64");
      } else if (sAny.uri) {
        const dl = await fetch(
          `${sAny.uri}${sAny.uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`,
          { signal: abortSignal },
        );
        if (!dl.ok) throw new ProviderError(`Vertex Veo download ${dl.status}`, "vertex");
        buf = Buffer.from(await dl.arrayBuffer());
      } else {
        throw new ProviderError("Vertex Veo finished but no video uri/bytes", "vertex");
      }
      const saved = await saveBuffer(buf, outputPath, guard);
      return { path: saved, provider: "vertex", model, operation: op.name };
    }
  }
  throw new TimeoutError(`generate_video vertex veo operation=${op.name}`, MAX_POLL_MS);
}

// ── DAEMORA-VERTEX-SA TEMP: Veo on Vertex AI via Service Account auth ──────

/**
 * DAEMORA-VERTEX-SA — TEMP. Veo on Vertex via SA JSON key auth.
 * Constants live at the top of this file (VERTEX_SA_*).
 *
 * Endpoint:
 *   POST https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}
 *        /locations/{LOCATION}/publishers/google/models/{MODEL}:predictLongRunning
 *
 * Auth: Bearer {access_token} minted from the SA JSON file.
 * Polling: :fetchPredictOperation (Vertex Veo's LRO endpoint).
 *
 * REMOVE THIS WHOLE FUNCTION + the constants + the dispatch branch when free-trial done.
 */
async function runVertexVeoSA(
  model: string,
  prompt: string,
  outputPath: string | undefined,
  guard: FilesystemGuard,
  abortSignal: AbortSignal,
  logger: { info: (msg: string, ctx?: object) => void },
): Promise<unknown> {
  // Lazy-import google-auth-library so the rest of the file works without it
  // (paid-only path; when removed later this import disappears with it).
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    keyFile: VERTEX_SA_KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = typeof tokenRes === "string" ? tokenRes : tokenRes?.token;
  if (!token) throw new ProviderError("Vertex SA auth: no access token", "vertex");

  const base = `https://${VERTEX_SA_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_SA_PROJECT_ID}/locations/${VERTEX_SA_LOCATION}/publishers/google/models/${model}`;
  const submitUrl = `${base}:predictLongRunning`;

  const submit = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, durationSeconds: 8 },
    }),
    signal: abortSignal,
  });
  if (!submit.ok) {
    const body = (await submit.text()).slice(0, 600);
    throw new ProviderError(
      `Vertex Veo SA submit ${submit.status} (project=${VERTEX_SA_PROJECT_ID}, location=${VERTEX_SA_LOCATION}, model=${model}): ${body}`,
      "vertex",
    );
  }
  const op = (await submit.json()) as { name?: string };
  if (!op.name) throw new ProviderError("Vertex Veo SA returned no operation name", "vertex");
  logger.info("generate_video polling Vertex Veo (SA)", { operation: op.name, projectId: VERTEX_SA_PROJECT_ID, location: VERTEX_SA_LOCATION, model });

  // Vertex Veo polls via :fetchPredictOperation (POST with body containing operationName).
  const fetchOpUrl = `${base}:fetchPredictOperation`;
  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    if (abortSignal.aborted) throw new TimeoutError("generate_video cancelled", 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(fetchOpUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: op.name }),
      signal: abortSignal,
    });
    if (!pollRes.ok) continue;
    const pollData = (await pollRes.json()) as {
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        videos?: Array<{ uri?: string; bytesBase64Encoded?: string; gcsUri?: string }>;
        generatedSamples?: Array<{ video?: { uri?: string; bytesBase64Encoded?: string } }>;
      };
    };
    if (pollData.error) {
      throw new ProviderError(`Vertex Veo SA failed: ${pollData.error.message ?? "unknown"}`, "vertex");
    }
    if (pollData.done) {
      const sample =
        pollData.response?.videos?.[0] ??
        pollData.response?.generatedSamples?.[0]?.video;
      if (!sample) {
        throw new ProviderError(
          `Vertex Veo SA finished but response shape unrecognized: ${JSON.stringify(pollData.response).slice(0, 400)}`,
          "vertex",
        );
      }
      let buf: Buffer;
      const sAny = sample as { uri?: string; bytesBase64Encoded?: string; gcsUri?: string };
      if (sAny.bytesBase64Encoded) {
        buf = Buffer.from(sAny.bytesBase64Encoded, "base64");
      } else if (sAny.uri) {
        const dl = await fetch(sAny.uri, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortSignal,
        });
        if (!dl.ok) {
          throw new ProviderError(`Vertex Veo SA download ${dl.status}: ${(await dl.text()).slice(0, 200)}`, "vertex");
        }
        buf = Buffer.from(await dl.arrayBuffer());
      } else {
        throw new ProviderError("Vertex Veo SA finished but no video uri/bytes in response", "vertex");
      }
      const saved = await saveBuffer(buf, outputPath, guard);
      return { path: saved, provider: "vertex", model, operation: op.name, auth: "sa" };
    }
  }
  throw new TimeoutError(`generate_video vertex veo SA operation=${op.name}`, MAX_POLL_MS);
}

// ── Google Veo (via Gemini API, API-key auth) ──────────────────

/**
 * Veo on Gemini Developer API. Submit returns a long-running operation
 * name. Poll the operation until `done: true`, then read the video URI
 * from `response.generateVideoResponse.generatedSamples[0].video.uri`.
 *
 * Operation polling URL: GET https://generativelanguage.googleapis.com/v1beta/{operationName}?key=API_KEY
 */
async function runVeo(
  key: string,
  model: string,
  prompt: string,
  outputPath: string | undefined,
  guard: FilesystemGuard,
  abortSignal: AbortSignal,
  logger: { info: (msg: string, ctx?: object) => void },
): Promise<unknown> {
  const submit = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
      }),
      signal: abortSignal,
    },
  );
  if (!submit.ok) {
    throw new ProviderError(`Veo submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`, "google");
  }
  const op = (await submit.json()) as { name?: string };
  if (!op.name) throw new ProviderError(`Veo returned no operation name`, "google");
  logger.info("generate_video polling Veo", { operation: op.name });

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    if (abortSignal.aborted) throw new TimeoutError("generate_video cancelled", 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${op.name}?key=${encodeURIComponent(key)}`,
      { signal: abortSignal },
    );
    if (!pollRes.ok) continue;
    const pollData = (await pollRes.json()) as {
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: Array<{ video?: { uri?: string } }>;
        };
      };
    };
    if (pollData.error) {
      throw new ProviderError(`Veo failed: ${pollData.error.message ?? "unknown"}`, "google");
    }
    if (pollData.done) {
      const uri = pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new ProviderError("Veo finished but no video uri in response", "google");
      // Veo returns a signed URL; download with the same API key for auth.
      const dl = await fetch(`${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, { signal: abortSignal });
      if (!dl.ok) throw new ProviderError(`Veo download ${dl.status}`, "google");
      const buf = Buffer.from(await dl.arrayBuffer());
      const saved = await saveBuffer(buf, outputPath, guard);
      return { path: saved, provider: "google", model, operation: op.name };
    }
  }
  throw new TimeoutError(`generate_video veo operation=${op.name}`, MAX_POLL_MS);
}

async function saveAsset(asset: OpenAiAsset, outputPath: string | undefined, guard: FilesystemGuard): Promise<string> {
  let dest = outputPath;
  if (dest) {
    dest = guard.ensureAllowed(dest, "write");
  } else {
    const dir = join(tmpdir(), "daemora-videos");
    await mkdir(dir, { recursive: true });
    dest = join(dir, `video-${Date.now()}.mp4`);
  }
  if (asset.b64_json) {
    await writeFile(dest, Buffer.from(asset.b64_json, "base64"));
  } else if (asset.url) {
    const dl = await fetch(asset.url);
    if (!dl.ok) throw new ProviderError(`Video download ${dl.status}`, "openai");
    await writeFile(dest, Buffer.from(await dl.arrayBuffer()));
  } else {
    throw new ProviderError("No video data in response", "openai");
  }
  return dest;
}

async function saveBuffer(buf: Buffer, outputPath: string | undefined, guard: FilesystemGuard): Promise<string> {
  let dest = outputPath;
  if (dest) {
    dest = guard.ensureAllowed(dest, "write");
  } else {
    const dir = join(tmpdir(), "daemora-videos");
    await mkdir(dir, { recursive: true });
    dest = join(dir, `video-${Date.now()}.mp4`);
  }
  await writeFile(dest, buf);
  return dest;
}
