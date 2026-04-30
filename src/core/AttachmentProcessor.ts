/**
 * AttachmentProcessor — normalise inbound files into model-ready input.
 *
 * A channel / HTTP upload hands us one or more `InboundAttachment`s.
 * Before the agent turn starts we:
 *
 *   1. Resolve each to a readable local path (downloading remote URLs
 *      into `<dataDir>/inbox/` if needed).
 *   2. Decide what to do based on kind/mime:
 *        image  → emit an `image` content-part alongside the text turn
 *                 (multimodal models see it inline)
 *        audio  → transcribe via existing STT pipeline + merge text
 *        text   → read the file and inline a bounded excerpt
 *        other  → leave on disk, append a `[file: /path (mime, size)]`
 *                 hint so the agent can reach for read_file / execute_command
 *
 * Returns the potentially-modified user text plus any image parts the
 * caller should merge into the message content array. Failures never
 * break the turn — the agent gets a best-effort result with any errors
 * noted inline.
 */

import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, extname } from "node:path";

import { createLogger } from "../util/logger.js";
import { transcribeAudioFile } from "../voice/transcribe.js";
import type { ConfigManager } from "../config/ConfigManager.js";

const log = createLogger("attachments");

/** Size caps to keep model context from exploding. */
const MAX_INLINE_TEXT_BYTES = 50_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — STT provider limit
const MAX_FILE_PART_BYTES = 20 * 1024 * 1024; // 20 MB — provider file-upload cap (Anthropic + Google)

/**
 * MIME types we pass to the model as first-class `file` content parts
 * (the AI SDK will forward them to provider-native document input
 * channels on Anthropic / Google / OpenAI). Anything else gets either
 * inlined as text (for small text files) or left on disk for the
 * agent's filesystem tools to open explicitly.
 */
const FILE_PART_MIMES = new Set<string>([
  "application/pdf",
]);

export interface RawAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "file";
  readonly url?: string;
  readonly path?: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly size?: number;
  readonly authHeader?: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly image: Buffer;
  readonly mimeType: string;
}

/**
 * File content part — forwarded as-is to the model. The AI SDK maps
 * this to provider-native document APIs (Anthropic's `document` block,
 * Google Gemini `inline_data`, OpenAI Responses file input) so the
 * model sees the original PDF with its text, tables, and figures
 * intact. No local text extraction.
 */
export interface FilePart {
  readonly type: "file";
  readonly data: Buffer;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface ProcessedAttachments {
  /** Amended user text — original text plus any inlined excerpts / hints. */
  readonly text: string;
  /** Image content parts to merge into the model message, if any. */
  readonly imageParts: readonly ImagePart[];
  /** File content parts (PDFs etc.) to merge into the model message. */
  readonly fileParts: readonly FilePart[];
}

export interface AttachmentProcessorDeps {
  readonly cfg: ConfigManager;
  readonly dataDir: string;
}

export class AttachmentProcessor {
  private readonly inboxDir: string;

  constructor(private readonly deps: AttachmentProcessorDeps) {
    this.inboxDir = join(deps.dataDir, "inbox");
    try {
      mkdirSync(this.inboxDir, { recursive: true });
    } catch {
      // directory creation failures are reported lazily when we try to write
    }
  }

  async process(
    baseText: string,
    attachments: readonly RawAttachment[] | undefined,
  ): Promise<ProcessedAttachments> {
    if (!attachments || attachments.length === 0) {
      return { text: baseText, imageParts: [], fileParts: [] };
    }

    const hints: string[] = [];
    const images: ImagePart[] = [];
    const files: FilePart[] = [];

    for (const att of attachments) {
      try {
        const localPath = await this.ensureLocal(att);
        const size = sizeOf(localPath);

        if (att.kind === "image" && size <= MAX_IMAGE_BYTES) {
          images.push({
            type: "image",
            image: readFileSync(localPath),
            mimeType: att.mimeType,
          });
          continue;
        }

        if (att.kind === "audio") {
          if (size > MAX_AUDIO_BYTES) {
            hints.push(`[audio: ${att.filename ?? basenameOf(localPath)} — too large to transcribe (${size} bytes), saved at ${localPath}]`);
            continue;
          }
          const transcript = await this.transcribe(localPath, att.mimeType);
          if (transcript) {
            hints.push(`[voice note transcript] ${transcript}`);
          } else {
            hints.push(`[audio: ${att.filename ?? basenameOf(localPath)} — transcription failed, saved at ${localPath}]`);
          }
          continue;
        }

        // PDFs (and future provider-supported doc types) go to the model
        // as a first-class `file` content part — the provider sees the
        // original bytes, keeping text + figures + layout intact. No
        // local parsing that would strip structure.
        if (FILE_PART_MIMES.has(att.mimeType) && size <= MAX_FILE_PART_BYTES) {
          files.push({
            type: "file",
            data: readFileSync(localPath),
            mimeType: att.mimeType,
            ...(att.filename ? { filename: att.filename } : {}),
          });
          continue;
        }

        if (isInlineableText(att.mimeType, localPath) && size <= MAX_INLINE_TEXT_BYTES) {
          const contents = readFileSync(localPath, "utf-8");
          hints.push(`[file: ${att.filename ?? basenameOf(localPath)}]\n${contents}`);
          continue;
        }

        // Fallback — oversized PDF, office doc, video, binary. Leave on
        // disk with a minimal hint so the agent can reach for read_file
        // / read_pdf / execute_command as needed.
        hints.push(
          `[file attached: ${att.filename ?? basenameOf(localPath)} (${att.mimeType}, ${size} bytes) — saved at ${localPath}]`,
        );
      } catch (e) {
        log.warn({ err: (e as Error).message, kind: att.kind, url: att.url }, "attachment processing failed");
        hints.push(`[file attach failed: ${att.filename ?? att.url ?? "?"} — ${(e as Error).message}]`);
      }
    }

    const text = [baseText, ...hints].filter((s) => s && s.length > 0).join("\n\n");
    return { text, imageParts: images, fileParts: files };
  }

  /**
   * Return a local path for the attachment. If the channel already
   * provided one we use it directly; otherwise we download the remote
   * URL into the inbox directory and return the saved path.
   */
  private async ensureLocal(att: RawAttachment): Promise<string> {
    if (att.path && existsSync(att.path)) return att.path;
    if (!att.url) throw new Error("attachment has neither path nor url");

    const headers: Record<string, string> = {};
    if (att.authHeader) headers["Authorization"] = att.authHeader;

    const resp = await fetch(att.url, { headers });
    if (!resp.ok) throw new Error(`fetch ${att.url} -> ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());
    const ext = att.filename ? extname(att.filename) : guessExt(att.mimeType);
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const full = join(this.inboxDir, name);
    writeFileSync(full, buf);
    return full;
  }

  private async transcribe(localPath: string, _mimeType: string): Promise<string | null> {
    try {
      const result = await transcribeAudioFile(this.deps.cfg, localPath);
      return result?.text ?? null;
    } catch (e) {
      log.warn({ err: (e as Error).message, path: localPath }, "transcription failed");
      return null;
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function basenameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

function isInlineableText(mime: string, path: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml") return true;
  const ext = extname(path).toLowerCase();
  return [".md", ".txt", ".log", ".csv", ".json", ".xml", ".yaml", ".yml", ".ini", ".toml"].includes(ext);
}

function guessExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  };
  return map[mime] ?? "";
}
