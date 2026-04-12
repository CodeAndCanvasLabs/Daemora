import { sidecarPost } from "./_sidecar.js";

export async function desktopMove(params = {}) {
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "Error: x and y required";
  const duration = Number(params.duration) || 0;
  await sidecarPost("/desktop/move", { x, y, duration });
  return `Moved cursor to (${x}, ${y})`;
}
