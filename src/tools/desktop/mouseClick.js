import { sidecarPost } from "./_sidecar.js";

export async function desktopClick(params = {}) {
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "Error: x and y are required numeric screen coordinates";
  const button = params.button || "left";
  const clicks = Number(params.clicks) || 1;
  await sidecarPost("/desktop/click", { x, y, button, clicks });
  return `Clicked (${button}×${clicks}) at (${x}, ${y})`;
}
