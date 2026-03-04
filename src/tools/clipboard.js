/**
 * clipboard - Read from or write to the system clipboard.
 * macOS: pbpaste/pbcopy. Linux: xclip/xsel. Windows: clip/powershell.
 */
import { execSync, execFileSync } from "node:child_process";

function platform() {
  return process.platform;
}

export async function clipboard(action, text) {
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
      if (!text) return "Error: text is required for write.";
      if (platform() === "darwin") {
        execSync(`echo ${JSON.stringify(text)} | pbcopy`, { timeout: 5000 });
      } else if (platform() === "linux") {
        try {
          execSync(`echo ${JSON.stringify(text)} | xclip -selection clipboard`, { timeout: 5000 });
        } catch {
          execSync(`echo ${JSON.stringify(text)} | xsel --clipboard --input`, { timeout: 5000 });
        }
      } else if (platform() === "win32") {
        execSync(`echo ${text} | clip`, { timeout: 5000 });
      } else {
        return "Error: clipboard write not supported on this platform.";
      }
      const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
      return `Copied to clipboard: "${preview}"`;
    }

    if (action === "clear") {
      return await clipboard("write", "");
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
