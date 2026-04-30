/**
 * read_pdf — extract text from a PDF.
 *
 * Strategy (first hit wins):
 *   1. `pdftotext` (poppler) — fast, local, free. Needs `brew install
 *      poppler` or `apt install poppler-utils`. Skipped silently when
 *      not installed.
 *   2. Native multimodal model — pass the raw PDF bytes to whichever
 *      model the user has configured (`DEFAULT_MODEL`) as a `file`
 *      content part. No text extraction: the provider sees the PDF
 *      with its layout, tables, and figures intact. No hardcoded
 *      model name — if the configured model doesn't support PDFs the
 *      provider surfaces a clear error.
 *
 * Supports `pages` only on the pdftotext path (the model path runs the
 * whole document because providers don't expose page slicing).
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { generateText } from "ai";
import { z } from "zod";

import type { ModelRouter } from "../../models/ModelRouter.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ProviderError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative path to the PDF."),
  pages: z.string().regex(/^\d+(-\d+)?$/).optional().describe("Page range like '1-5' or single page '3' (pdftotext only)."),
  method: z.enum(["auto", "pdftotext", "model"]).default("auto")
    .describe("Extraction method: 'auto' tries pdftotext then the configured model; 'pdftotext' forces local; 'model' forces the configured multimodal model."),
  /**
   * Optional model override — format `provider:model`. When omitted the
   * tool uses whatever `DEFAULT_MODEL` is set to in Settings. We do NOT
   * ship a hardcoded default here: model names age fast and every user
   * should drive inference through the same model they picked for chat.
   */
  model: z.string().optional().describe("Optional model override ('provider:model'). Defaults to the configured DEFAULT_MODEL."),
  maxChars: z.number().int().positive().max(2_000_000).default(500_000)
    .describe("Truncate the returned text to this many characters. 500 KB default prevents blowing context."),
});

export function makeReadPDFTool(
  guard: FilesystemGuard,
  models: ModelRouter,
): ToolDef<typeof inputSchema, string> {
  return {
    name: "read_pdf",
    description:
      "Extract text from a PDF file. Tries pdftotext (poppler) first, then falls back to the user's configured multimodal model reading the PDF natively. Supports page ranges via 'pages' (pdftotext only).",
    category: "filesystem",
    source: { kind: "core" },
    tags: ["pdf", "extract"],
    inputSchema,
    async execute({ path, pages, method, model, maxChars }, { logger }) {
      const canonical = guard.ensureAllowed(path, "read");

      let s;
      try {
        s = await stat(canonical);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new NotFoundError(`PDF not found: ${canonical}`);
        throw err;
      }
      if (!s.isFile()) throw new ValidationError(`Not a file: ${canonical}`);

      // 1) pdftotext (if present, and method allows)
      if (method === "auto" || method === "pdftotext") {
        const text = await tryPdftotext(canonical, pages, logger);
        if (text !== null && text.trim().length > 0) {
          return truncate(text, maxChars);
        }
        if (method === "pdftotext") {
          throw new ProviderError(
            "pdftotext returned no text. Install poppler-utils and confirm the PDF isn't image-only.",
            "pdftotext",
          );
        }
        logger.info("read_pdf falling back to configured model");
      }

      // 2) Configured multimodal model — no hardcoded name, no broken
      //    vision-via-image_url path. The AI SDK maps `file` content
      //    parts to each provider's native document API.
      if (method === "auto" || method === "model") {
        const modelId = model ?? models.resolveDefault();
        const resolved = await models.resolve(modelId);
        const bytes = await readFile(canonical);
        try {
          const { text } = await generateText({
            model: resolved.model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Extract all text content from this PDF. Preserve headings, lists, tables, and paragraph structure. Return only the extracted text — no preamble." },
                  { type: "file", data: bytes, mediaType: "application/pdf" },
                ],
              },
            ],
          });
          if (!text || text.trim().length === 0) {
            throw new ProviderError(
              `Model ${modelId} returned empty output for the PDF. It may not support PDF input — try a different DEFAULT_MODEL or install poppler-utils.`,
              "model",
            );
          }
          return truncate(text, maxChars);
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          throw new ProviderError(
            `PDF extraction via ${modelId} failed: ${msg}. If the model doesn't accept PDFs, install poppler-utils (pdftotext) or pick a PDF-capable model in Settings.`,
            "model",
          );
        }
      }

      throw new ValidationError(`Unknown method: ${method}`);
    },
  };
}

async function tryPdftotext(
  canonicalPath: string,
  pageRange: string | undefined,
  logger: { warn: (msg: string, ctx?: object) => void },
): Promise<string | null> {
  const args: string[] = [];
  if (pageRange) {
    const [first, second] = pageRange.split("-");
    args.push("-f", first ?? "1", "-l", second ?? first ?? "1");
  }
  args.push(canonicalPath, "-");
  try {
    const { stdout } = await execFileAsync("pdftotext", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") return null; // pdftotext not installed
    logger.warn("pdftotext failed", { error: err.message, stderr: err.stderr });
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…[truncated — PDF exceeded ${maxChars} chars]`;
}
