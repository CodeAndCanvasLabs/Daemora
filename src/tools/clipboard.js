/**
 * clipboard - Read from or write to the system clipboard.
 * macOS: pbpaste/pbcopy. Linux: xclip/xsel. Windows: clip/powershell.
 *
 * Writes use spawnSync (no shell) to prevent command injection from clipboard text.
 */
import { execSync, spawnSync } from "node:child_process";

/** Write `text` to a process's stdin via spawnSync (no shell, injection-safe). */
function pipeToProcess(cmd, args, text, timeout = 5000) {
  const result = spawnSync(cmd, args, {
    input: text,
    encoding: "utf-8",
    timeout,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${cmd} exited with ${result.status}`);
  return result;
}

function platform() {
  return process.platform;
}

export async function clipboard(params) {
  const action = params?.action;
  const text = params?.text;
  if (!action) return 'Error: action required. Valid: read, write, clear';

  try {
    if (action === "read") {
      let out;
      if (platform() === "darwin") {
        out = execSync("pbpaste", { encoding: "utf-8", timeout: 5000 });
      } else if (platform() === "linux") {
        try {
          out = execSync("xclip -selection clipboard -o", { encoding: "utf-8", timeout: 5000 });
        } catch {
          out = execSync("xsel --clipboard --output", { encoding: "utf-8", timeout: 5000 });
        }
      } else if (platform() === "win32") {
        out = execSync("powershell -command Get-Clipboard", { encoding: "utf-8", timeout: 5000 });
      } else {
        return "Error: clipboard read not supported on this platform.";
      }
      const content = out.trim();
      if (!content) return "(clipboard is empty)";
      return `Clipboard content:\n${content}`;
    }

    if (action === "write") {
      if (text == null) return "Error: text is required for write.";
      if (platform() === "darwin") {
        pipeToProcess("pbcopy", [], text);
      } else if (platform() === "linux") {
        try {
          pipeToProcess("xclip", ["-selection", "clipboard"], text);
        } catch {
          pipeToProcess("xsel", ["--clipboard", "--input"], text);
        }
      } else if (platform() === "win32") {
        pipeToProcess("clip", [], text);
      } else {
        return "Error: clipboard write not supported on this platform.";
      }
      const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
      return `Copied to clipboard: "${preview}"`;
    }

    if (action === "clear") {
      return await clipboard({ action: "write", text: "" });
    }

    return `Unknown action: "${action}". Valid: read, write, clear`;
  } catch (err) {
    return `Clipboard error: ${err.message}. Make sure xclip or xsel is installed on Linux.`;
  }
}

export const clipboardDescription =
  `clipboard(action: string, text?: string) - Read or write the system clipboard.
  action: "read" | "write" | "clear"
  text: content to write (required for write)
  Examples:
    clipboard("read")                          → returns clipboard contents
    clipboard("write", "Hello World")          → copies text to clipboard
    clipboard("clear")                         → clears clipboard`;
