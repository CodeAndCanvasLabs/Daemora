/**
 * screenCapture(optionsJson?) - Take a screenshot or record a screen video.
 *
 * Modes:
 *   screenshot (default) - single still image (PNG)
 *   video                - screen recording (MP4), uses `duration` seconds (default 10)
 *
 * macOS: uses built-in `screencapture` command.
 * Linux: screenshots via ImageMagick/gnome-screenshot/scrot; video via ffmpeg.
 *
 * Returns the path to the saved file. Chain with imageAnalysis for screenshots,
 * or sendFile to deliver the result to the user.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";

export function screenCapture(params) {
  try {
    const opts = _mergeLegacyOpts(params);
    const outputDir = opts.outputDir || getTenantTmpDir("daemora-captures");
    const region    = opts.region;                   // { x, y, width, height } - screenshot only
    const mode      = (opts.mode || "screenshot").toLowerCase();
    const duration  = parseInt(opts.duration || "10", 10); // seconds - video only

    const wc = filesystemGuard.checkWrite(outputDir);
    if (!wc.allowed) return `Error: ${wc.reason}`;

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const os = platform();

    // ── Screenshot mode ──────────────────────────────────────────────────────
    if (mode === "screenshot") {
      const outputPath = join(outputDir, `screenshot-${timestamp}.png`);

      if (os === "darwin") {
        if (region) {
          const { x = 0, y = 0, width = 800, height = 600 } = region;
          execSync(`screencapture -x -R ${x},${y},${width},${height} "${outputPath}"`, { timeout: 10000 });
        } else {
          execSync(`screencapture -x "${outputPath}"`, { timeout: 10000 });
        }
      } else if (os === "linux") {
        const tools = [
          `import -window root "${outputPath}"`,
          `gnome-screenshot -f "${outputPath}"`,
          `scrot "${outputPath}"`,
          `xwd -root -silent | convert xwd:- "${outputPath}"`,
        ];
        let captured = false;
        for (const cmd of tools) {
          try { execSync(cmd, { timeout: 10000 }); captured = true; break; } catch {}
        }
        if (!captured) {
          return "Error: No screenshot tool available. Install ImageMagick: sudo apt install imagemagick";
        }
      } else {
        return `Error: screenCapture is not supported on ${os}. Supported: macOS (darwin), Linux.`;
      }

      if (!existsSync(outputPath)) {
        if (os === "darwin") {
          return "Error: Screenshot failed. The terminal app likely needs Screen Recording permission. Go to: System Settings → Privacy & Security → Screen Recording → enable your terminal app, then restart it.";
        }
        return "Error: Screenshot command ran but no file was created.";
      }

      if (os === "darwin") {
        const fileSize = statSync(outputPath).size;
        if (fileSize < 500) {
          return `Error: Screenshot captured but appears empty (${fileSize} bytes). The terminal app likely needs Screen Recording permission. Go to: System Settings → Privacy & Security → Screen Recording → enable your terminal app, then restart it.`;
        }
      }

      return `Screenshot saved to: ${outputPath}`;
    }

    // ── Video mode ────────────────────────────────────────────────────────────
    if (mode === "video") {
      if (duration < 1 || duration > 300) {
        return "Error: duration must be between 1 and 300 seconds.";
      }
      const outputPath = join(outputDir, `video-${timestamp}.mp4`);
      const timeoutMs  = (duration + 30) * 1000;

      if (os === "darwin") {
        // screencapture -V records video. Available macOS 10.15+.
        execSync(`screencapture -V ${duration} "${outputPath}"`, { timeout: timeoutMs });
      } else if (os === "linux") {
        // Try ffmpeg first (most capable), then recordmydesktop
        const ffmpegCmd = `ffmpeg -y -f x11grab -t ${duration} -i :0.0 -c:v libx264 -preset fast "${outputPath}" 2>/dev/null`;
        const rmdCmd    = `recordmydesktop --no-sound --fps 15 -o "${outputPath}" & sleep ${duration} && kill %1`;

        let recorded = false;
        for (const cmd of [ffmpegCmd, rmdCmd]) {
          try { execSync(cmd, { timeout: timeoutMs }); recorded = true; break; } catch {}
        }
        if (!recorded) {
          return "Error: No video recording tool available. Install ffmpeg: sudo apt install ffmpeg";
        }
      } else {
        return `Error: Video recording is not supported on ${os}.`;
      }

      if (!existsSync(outputPath)) {
        return "Error: Video recording ran but no file was created.";
      }
      return `Video saved to: ${outputPath} (${duration}s)`;
    }

    return `Error: Unknown mode "${mode}". Use "screenshot" or "video".`;
  } catch (error) {
    return `Error in screenCapture: ${error.message}`;
  }
}

export const screenCaptureDescription =
  'screenCapture(optionsJson?) - Capture a screenshot or record a screen video. ' +
  'optionsJson: {"mode":"screenshot"|"video","outputDir":"/tmp","duration":10,"region":{"x":0,"y":0,"width":800,"height":600}}. ' +
  'mode defaults to "screenshot". duration (seconds) only applies to video mode. ' +
  'Returns the file path. Chain with imageAnalysis to analyze screenshots, or sendFile to deliver to user.';
