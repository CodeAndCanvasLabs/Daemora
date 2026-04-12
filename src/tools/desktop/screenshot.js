import { sidecarPost } from "./_sidecar.js";

export async function desktopScreenshot(params = {}) {
  const body = {};
  if (params.x != null && params.y != null && params.width && params.height) {
    body.region = {
      x: Number(params.x),
      y: Number(params.y),
      width: Number(params.width),
      height: Number(params.height),
    };
  }
  const res = await sidecarPost("/desktop/screenshot", body);
  return `Screenshot captured (${res.width}×${res.height}): ${res.path}`;
}
