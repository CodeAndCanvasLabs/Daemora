/**
 * imageOps - Local image processing using Sharp.
 * Operations: resize, compress, convert, crop, rotate, blur, grayscale.
 * No API key needed — runs entirely on the local machine.
 */
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";

let sharp;

async function _getSharp() {
  if (sharp) return sharp;
  try {
    sharp = (await import("sharp")).default;
    return sharp;
  } catch {
    return null;
  }
}

export async function imageOps(params) {
  const { inputPath, operation, outputPath } = params || {};
  if (!inputPath) return "Error: inputPath is required.";
  if (!operation) return "Error: operation is required (resize, compress, convert, crop, rotate, blur, grayscale, metadata).";

  const rc = filesystemGuard.checkRead(inputPath);
  if (!rc.allowed) return `Error: ${rc.reason}`;
  if (!existsSync(inputPath)) return `Error: File not found: ${inputPath}`;

  const sharpLib = await _getSharp();
  if (!sharpLib) return "Error: Sharp not installed. Run: npm install sharp";

  try {
    let img = sharpLib(inputPath);
    const dir = getTenantTmpDir("daemora-images");
    let ext = extname(inputPath) || ".png";
    let outPath = outputPath;

    switch (operation) {
      case "resize": {
        const width = params.width ? parseInt(params.width) : null;
        const height = params.height ? parseInt(params.height) : null;
        if (!width && !height) return "Error: width or height required for resize.";
        img = img.resize(width || null, height || null, { fit: "inside", withoutEnlargement: true });
        break;
      }
      case "compress": {
        const quality = parseInt(params.quality) || 80;
        const format = params.format || ext.replace(".", "") || "jpeg";
        if (format === "jpeg" || format === "jpg") img = img.jpeg({ quality });
        else if (format === "png") img = img.png({ quality: Math.min(quality, 100) });
        else if (format === "webp") img = img.webp({ quality });
        ext = `.${format}`;
        break;
      }
      case "convert": {
        const format = params.format;
        if (!format) return "Error: format required for convert (jpeg, png, webp, gif, avif, tiff).";
        img = img.toFormat(format);
        ext = `.${format}`;
        break;
      }
      case "crop": {
        const left = parseInt(params.left) || 0;
        const top = parseInt(params.top) || 0;
        const width = parseInt(params.width);
        const height = parseInt(params.height);
        if (!width || !height) return "Error: width and height required for crop.";
        img = img.extract({ left, top, width, height });
        break;
      }
      case "rotate": {
        const angle = parseInt(params.angle) || 90;
        img = img.rotate(angle);
        break;
      }
      case "blur": {
        const sigma = parseFloat(params.sigma) || 5;
        img = img.blur(sigma);
        break;
      }
      case "grayscale": {
        img = img.grayscale();
        break;
      }
      case "metadata": {
        const meta = await sharpLib(inputPath).metadata();
        return `Image metadata for ${basename(inputPath)}:\n- Format: ${meta.format}\n- Size: ${meta.width}×${meta.height}\n- Channels: ${meta.channels}\n- Space: ${meta.space}\n- File size: ${meta.size ? `${(meta.size / 1024).toFixed(1)}KB` : "unknown"}`;
      }
      default:
        return `Error: Unknown operation "${operation}". Supported: resize, compress, convert, crop, rotate, blur, grayscale, metadata.`;
    }

    if (!outPath) {
      outPath = join(dir, `${basename(inputPath, extname(inputPath))}-${operation}${ext}`);
    }

    if (outputPath) {
      const wc = filesystemGuard.checkWrite(outputPath);
      if (!wc.allowed) return `Error: ${wc.reason}`;
    }

    await img.toFile(outPath);
    console.log(`[imageOps] ${operation}: ${inputPath} → ${outPath}`);
    return `Image ${operation} complete. Saved to: ${outPath}`;
  } catch (err) {
    return `Error processing image: ${err.message}`;
  }
}
