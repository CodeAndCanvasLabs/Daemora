/**
 * image_ops — local image manipulation via `sharp`.
 *
 * All operations run on the local machine — no API calls, no key
 * required. Supports: resize, compress, convert, crop, rotate, blur,
 * grayscale, metadata.
 *
 * Outputs go to the user-specified path (if writable per the
 * filesystem guard) or to a temp file under the OS tmpdir. The
 * returned value includes the output path so the agent can chain
 * this into a follow-up tool (e.g. `read_file` on the metadata or
 * `image_analysis` on the result).
 */

import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ProviderError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const OPERATIONS = [
  "resize",
  "compress",
  "convert",
  "crop",
  "rotate",
  "blur",
  "grayscale",
  "metadata",
] as const;

const FORMATS = ["jpeg", "jpg", "png", "webp", "gif", "avif", "tiff"] as const;

const inputSchema = z.object({
  inputPath: z.string().min(1).describe("Source image path. Read through the filesystem guard."),
  operation: z.enum(OPERATIONS).describe("Which image operation to perform."),
  outputPath: z.string().optional().describe("Optional destination path. Defaults to a temp file."),
  // resize / crop
  width: z.number().int().positive().optional().describe("Target width in pixels (resize/crop)."),
  height: z.number().int().positive().optional().describe("Target height in pixels (resize/crop)."),
  left: z.number().int().min(0).optional().describe("Crop origin X (default 0)."),
  top: z.number().int().min(0).optional().describe("Crop origin Y (default 0)."),
  // compress / convert
  quality: z.number().int().min(1).max(100).optional().describe("Output quality, 1-100 (default 80)."),
  format: z.enum(FORMATS).optional().describe("Target image format for compress/convert."),
  // rotate
  angle: z.number().optional().describe("Rotation angle in degrees (default 90)."),
  // blur
  sigma: z.number().positive().optional().describe("Gaussian blur sigma (default 5)."),
});

export interface ImageOpsResult {
  readonly operation: string;
  readonly outputPath?: string;
  readonly metadata?: ImageMetadata;
  readonly message: string;
}

export interface ImageMetadata {
  readonly format: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly channels: number | undefined;
  readonly space: string | undefined;
  readonly sizeBytes: number | undefined;
}

export function makeImageOpsTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, ImageOpsResult> {
  return {
    name: "image_ops",
    description:
      "Run local image operations (resize, compress, convert, crop, rotate, blur, grayscale, metadata) via sharp. Returns the output path.",
    category: "media",
    source: { kind: "core" },
    tags: ["image", "resize", "convert", "compress", "sharp"],
    inputSchema,
    async execute(input, { logger }) {
      const { inputPath, operation } = input;

      const srcCanonical = guard.ensureAllowed(inputPath, "read");
      let s;
      try {
        s = await stat(srcCanonical);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new NotFoundError(`Image not found: ${srcCanonical}`);
        throw err;
      }
      if (!s.isFile()) throw new ValidationError(`Not a file: ${srcCanonical}`);

      const sharp = await loadSharp();
      if (!sharp) throw new ProviderError("sharp not installed. Run: npm install sharp", "sharp");

      // Metadata is read-only — handle and return early.
      if (operation === "metadata") {
        const meta = await sharp(srcCanonical).metadata();
        const metadata: ImageMetadata = {
          format: meta.format,
          width: meta.width,
          height: meta.height,
          channels: meta.channels,
          space: meta.space,
          sizeBytes: meta.size,
        };
        return {
          operation,
          metadata,
          message: `Image metadata for ${basename(srcCanonical)}: ${metadata.format ?? "?"} ${metadata.width ?? "?"}×${metadata.height ?? "?"}`,
        };
      }

      let img = sharp(srcCanonical);
      let ext = extname(srcCanonical) || ".png";

      switch (operation) {
        case "resize": {
          if (!input.width && !input.height) {
            throw new ValidationError("resize needs width and/or height");
          }
          img = img.resize(input.width ?? null, input.height ?? null, {
            fit: "inside",
            withoutEnlargement: true,
          });
          break;
        }
        case "compress": {
          const quality = input.quality ?? 80;
          const format = (input.format ?? ext.replace(".", "")) as typeof FORMATS[number];
          if (format === "jpeg" || format === "jpg") img = img.jpeg({ quality });
          else if (format === "png") img = img.png({ quality: Math.min(quality, 100) });
          else if (format === "webp") img = img.webp({ quality });
          else throw new ValidationError(`compress doesn't support format '${format}'`);
          ext = `.${format === "jpg" ? "jpg" : format}`;
          break;
        }
        case "convert": {
          if (!input.format) throw new ValidationError("convert needs format");
          img = img.toFormat(input.format);
          ext = `.${input.format}`;
          break;
        }
        case "crop": {
          if (!input.width || !input.height) throw new ValidationError("crop needs width and height");
          img = img.extract({
            left: input.left ?? 0,
            top: input.top ?? 0,
            width: input.width,
            height: input.height,
          });
          break;
        }
        case "rotate": {
          img = img.rotate(input.angle ?? 90);
          break;
        }
        case "blur": {
          img = img.blur(input.sigma ?? 5);
          break;
        }
        case "grayscale": {
          img = img.grayscale();
          break;
        }
        default: {
          throw new ValidationError(`Unknown operation: ${operation satisfies never}`);
        }
      }

      const outputPath = input.outputPath
        ? guard.ensureAllowed(input.outputPath, "write")
        : await defaultOutputPath(srcCanonical, operation, ext);

      await img.toFile(outputPath);
      logger.info("image_ops complete", { operation, input: srcCanonical, output: outputPath });

      return {
        operation,
        outputPath,
        message: `Image ${operation} complete → ${outputPath}`,
      };
    },
  };
}

async function defaultOutputPath(srcPath: string, op: string, ext: string): Promise<string> {
  const dir = join(tmpdir(), "daemora-images");
  await mkdir(dir, { recursive: true });
  return join(dir, `${basename(srcPath, extname(srcPath))}-${op}${ext}`);
}

/**
 * sharp is a large native dep — lazy-load so the server still starts
 * even if the user hasn't installed it. Returns null on failure; the
 * caller surfaces a helpful install message to the model.
 */
// `sharp` is intentionally NOT in package.json — it's a heavy native
// module the user opts into. Keep the type as `any` so tsc doesn't
// need its declarations to compile (callers chain off the result).
type SharpFn = (input?: string | Buffer) => any;
async function loadSharp(): Promise<SharpFn | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("sharp" as string)) as any;
    return (mod.default ?? mod) as SharpFn;
  } catch {
    return null;
  }
}
