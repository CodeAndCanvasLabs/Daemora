import { sidecarPost } from "./_sidecar.js";

export async function desktopKeyCombo(params = {}) {
  const raw = params.keys;
  const keys = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("+").map(s => s.trim()) : null;
  if (!keys || keys.length === 0) return "Error: keys required — array or plus-separated string (e.g. 'cmd+c')";
  await sidecarPost("/desktop/combo", { keys });
  return `Pressed combo: ${keys.join("+")}`;
}
