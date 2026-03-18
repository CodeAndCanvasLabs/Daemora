/**
 * iMessageTool - Send iMessages and SMS via macOS Messages app.
 * Requires macOS with Messages app configured and accessibility permissions.
 * Uses osascript (AppleScript) — no external deps.
 */
import { execSync } from "node:child_process";
import { mergeLegacyParams as _mergeLegacy } from "../../../src/utils/mergeToolParams.js";

export async function iMessageTool(_params) {
  const action = _params?.action;
  if (!action) return "Error: action required. Valid: send, read";
  const params = _mergeLegacy(_params);

  if (process.platform !== "darwin") {
    return "Error: iMessage tool is macOS-only (requires Messages app via AppleScript)";
  }

  if (action === "send") {
    const { to, message, service = "iMessage" } = params;
    if (!to) return "Error: 'to' (phone number or email) is required";
    if (!message) return "Error: 'message' is required";

    // Validate service type
    const validServices = ["iMessage", "SMS"];
    if (!validServices.includes(service)) {
      return `Error: invalid service "${service}". Valid: iMessage, SMS`;
    }

    const script = `
      tell application "Messages"
        set targetService to 1st service whose service type = ${service}
        set targetBuddy to buddy "${to.replace(/"/g, '\\"')}" of targetService
        send "${message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" to targetBuddy
      end tell
    `;

    try {
      execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { timeout: 10000 });
      return `${service} sent to ${to}: "${message.length > 60 ? message.slice(0, 60) + "..." : message}"`;
    } catch (err) {
      return `iMessage error: ${err.message}. Make sure Messages app is open and has the contact.`;
    }
  }

  if (action === "read") {
    const { count = 10 } = params;
    // AppleScript to read recent messages
    const script = `
      tell application "Messages"
        set output to ""
        set allChats to chats
        repeat with aChat in allChats
          set msgCount to count of messages of aChat
          if msgCount > 0 then
            set lastMsg to last message of aChat
            set output to output & name of aChat & ": " & content of lastMsg & "\\n"
          end if
        end repeat
        return output
      end tell
    `;

    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      if (!result.trim()) return "No recent messages found";
      return `Recent messages:\n${result.trim()}`;
    } catch (err) {
      return `Error reading messages: ${err.message}`;
    }
  }

  return `Unknown action: "${action}". Valid: send, read`;
}

export const iMessageToolDescription =
  `iMessageTool(action: string, paramsJson?: object) - Send and read iMessages/SMS on macOS.
  action: "send" | "read"
  send params: { to: "+1234567890"|"email@icloud.com", message: "text", service?: "iMessage"|"SMS" }
  read params: { count?: 10 }
  Requires: macOS with Messages app configured + Accessibility permissions for osascript
  Examples:
    iMessageTool("send", {"to":"+15551234567","message":"Hello!"})
    iMessageTool("read", {"count":5})`;
