import { sidecarPost } from "./_sidecar.js";

export async function desktopFocusWindow(params = {}) {
  const name = params.name;
  if (!name) return "Error: name required (app name on macOS, window title substring on Windows)";
  const res = await sidecarPost("/desktop/focus", { name });
  if (!res.ok) return `Error focusing '${name}': ${res.error || "unknown"}`;
  return `Focused '${name}'`;
}
