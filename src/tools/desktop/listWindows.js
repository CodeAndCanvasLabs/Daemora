import { sidecarGet } from "./_sidecar.js";

export async function desktopListWindows() {
  const res = await sidecarGet("/desktop/windows");
  const windows = res.windows || [];
  if (!windows.length) return "No visible windows detected";
  return windows
    .map(w => `${w.active ? "●" : "○"} ${w.title}${w.pid ? ` (pid ${w.pid})` : ""}`)
    .join("\n");
}
