import { sidecarPost } from "./_sidecar.js";

export async function desktopType(params = {}) {
  const text = params.text;
  if (typeof text !== "string" || !text.length) return "Error: text is required";
  const interval = Number(params.interval) || 0.01;
  const res = await sidecarPost("/desktop/type", { text, interval });
  return `Typed ${res.chars ?? text.length} characters into focused window`;
}
