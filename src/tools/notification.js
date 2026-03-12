/**
 * notification - Send desktop / mobile push notifications.
 * macOS: osascript / terminal-notifier. Linux: notify-send. Windows: PowerShell.
 * Cross-platform mobile: Pushover, Pushbullet, Ntfy.sh.
 */
import { resolveKey } from "./_env.js";
import { execSync } from "node:child_process";

function platform() { return process.platform; }

export async function notification(params) {
  const title = params?.title;
  const message = params?.message;
  const options = params?.options || {};
  if (!title) return "Error: title is required";
  if (!message) return "Error: message is required";

  const opts = typeof options === "string" ? JSON.parse(options) : (options || {});
  const { sound = false, url = null, service = "desktop", topic = null } = opts;

  // ── Desktop notification ────────────────────────────────────────────────
  if (service === "desktop") {
    try {
      if (platform() === "darwin") {
        // Use osascript for macOS (built-in, no deps)
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${sound ? " sound name \"Glass\"" : ""}`;
        execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { timeout: 5000 });
        return `Notification sent: "${title}"`;
      } else if (platform() === "linux") {
        const urgency = opts.urgency || "normal";
        const expireMs = opts.expireMs || 5000;
        execSync(`notify-send -u ${urgency} -t ${expireMs} ${JSON.stringify(title)} ${JSON.stringify(message)}`, { timeout: 5000 });
        return `Notification sent: "${title}"`;
      } else if (platform() === "win32") {
        const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $template.SelectSingleNode('//text[@id=1]').AppendChild($template.CreateTextNode('${title.replace(/'/g, "''")}')) > $null; $template.SelectSingleNode('//text[@id=2]').AppendChild($template.CreateTextNode('${message.replace(/'/g, "''")}')) > $null; $toast = [Windows.UI.Notifications.ToastNotification]::new($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Daemora').Show($toast)`;
        execSync(`powershell -Command "${ps}"`, { timeout: 5000 });
        return `Notification sent: "${title}"`;
      } else {
        return "Error: desktop notifications not supported on this platform";
      }
    } catch (err) {
      return `Notification error: ${err.message}`;
    }
  }

  // ── Ntfy.sh (HTTP push — open source, self-hostable) ───────────────────
  if (service === "ntfy") {
    const ntfyUrl = resolveKey("NTFY_URL") || "https://ntfy.sh";
    const ntfyTopic = topic || resolveKey("NTFY_TOPIC");
    if (!ntfyTopic) return "Error: NTFY_TOPIC env var or topic option required for ntfy service";

    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const res = await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": title,
        ...(url ? { "Click": url } : {}),
        ...(resolveKey("NTFY_TOKEN") ? { "Authorization": `Bearer ${resolveKey("NTFY_TOKEN")}` } : {}),
      },
    });
    if (!res.ok) return `Ntfy error: ${res.status} ${await res.text()}`;
    return `Ntfy notification sent to topic "${ntfyTopic}": "${title}"`;
  }

  // ── Pushover ────────────────────────────────────────────────────────────
  if (service === "pushover") {
    const token = resolveKey("PUSHOVER_API_TOKEN");
    const user = resolveKey("PUSHOVER_USER_KEY");
    if (!token || !user) return "Error: PUSHOVER_API_TOKEN and PUSHOVER_USER_KEY env vars required";

    const body = new URLSearchParams({ token, user, title, message });
    if (url) body.set("url", url);

    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const res = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body });
    const data = await res.json();
    if (data.status !== 1) return `Pushover error: ${JSON.stringify(data.errors)}`;
    return `Pushover notification sent: "${title}"`;
  }

  return `Unknown service: "${service}". Valid: desktop, ntfy, pushover`;
}

export const notificationDescription =
  `notification(title: string, message: string, options?: object) - Send desktop or push notifications.
  options.service: "desktop" (default) | "ntfy" | "pushover"
  options.sound: boolean (macOS only, plays Glass sound)
  options.url: URL to open on click (ntfy/pushover)
  options.topic: ntfy topic name (or set NTFY_TOPIC env)
  Env vars: NTFY_URL, NTFY_TOPIC, NTFY_TOKEN, PUSHOVER_API_TOKEN, PUSHOVER_USER_KEY
  Examples:
    notification("Task done", "Your report is ready")               → desktop alert
    notification("Alert", "Server down", {"service":"ntfy","topic":"myalerts"})`;
