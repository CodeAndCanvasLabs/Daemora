import { sidecarPost } from "./_sidecar.js";

export async function desktopScroll(params = {}) {
  const dx = Number(params.dx) || 0;
  const dy = Number(params.dy) || 0;
  if (dx === 0 && dy === 0) return "Error: at least one of dx or dy must be non-zero";
  await sidecarPost("/desktop/scroll", { dx, dy });
  return `Scrolled dx=${dx} dy=${dy}`;
}
