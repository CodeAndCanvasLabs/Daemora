/**
 * imageAnalysis(imagePath, prompt?) - Analyze images using vision AI models.
 * Supports local files, URLs, and data: URIs.
 * Uses the Vercel AI SDK with whatever vision-capable model is configured.
 */
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { generateText } from "ai";
import { getModelWithFallback } from "../models/ModelRouter.js";

const MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

// Vision-capable models to prefer (in order)
const VISION_MODEL_PREFERENCE = [
  "google:gemini-2.0-flash",
  "openai:gpt-4.1",
  "openai:gpt-4.1-mini",
  "anthropic:claude-sonnet-4-6",
];

export async function imageAnalysis(params) {
  const imagePath = params?.imagePath;
  const prompt = params?.prompt;
  try {
    const description = prompt || "Describe this image in detail. Include all visible text, UI elements, code, diagrams, or any other relevant content.";

    let imageData;
    let mimeType;

    if (!imagePath) {
      return "Error: imagePath is required";
    }

    if (imagePath.startsWith("data:")) {
      // data: URI - extract base64 and mime type
      const match = imagePath.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return "Error: Invalid data: URI format";
      mimeType = match[1];
      imageData = match[2];
    } else if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
      // URL - fetch and convert to base64
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(imagePath, {
          signal: controller.signal,
          headers: { "User-Agent": "Daemora/1.0" },
        });
        clearTimeout(timeout);
        if (!res.ok) return `Error fetching image: HTTP ${res.status}`;
        const contentType = res.headers.get("content-type") || "image/jpeg";
        mimeType = contentType.split(";")[0].trim();
        const buffer = await res.arrayBuffer();
        imageData = Buffer.from(buffer).toString("base64");
      } catch (err) {
        clearTimeout(timeout);
        return `Error fetching image URL: ${err.message}`;
      }
    } else {
      // Local file
      if (!existsSync(imagePath)) {
        return `Error: File not found: ${imagePath}`;
      }
      const ext = extname(imagePath).toLowerCase();
      mimeType = MIME_MAP[ext];
      if (!mimeType) {
        return `Error: Unsupported image type: ${ext}. Supported: ${Object.keys(MIME_MAP).join(", ")}`;
      }
      const buffer = readFileSync(imagePath);
      imageData = buffer.toString("base64");
    }

    // Use the configured default model first (it's vision-capable in most cases),
    // then fall back to the preference list
    let selectedModel = null;
    try {
      const { model } = getModelWithFallback(null);
      if (model) selectedModel = model;
    } catch {}
    if (!selectedModel) {
      for (const modelId of VISION_MODEL_PREFERENCE) {
        try {
          const { model } = getModelWithFallback(modelId);
          if (model) { selectedModel = model; break; }
        } catch {}
      }
    }

    const response = await generateText({
      model: selectedModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: imageData,
              mimeType,
            },
            {
              type: "text",
              text: description,
            },
          ],
        },
      ],
      maxTokens: 2048,
    });

    return response.text || "No analysis returned from model.";
  } catch (error) {
    return `Error analyzing image: ${error.message}`;
  }
}

export const imageAnalysisDescription =
  'imageAnalysis(imagePath: string, prompt?: string) - Analyze an image using AI vision. imagePath can be a local file path, URL, or data: URI. prompt is optional (defaults to "describe this image").';
