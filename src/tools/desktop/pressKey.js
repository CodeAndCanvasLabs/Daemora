import { sidecarPost } from "./_sidecar.js";

export async function desktopPressKey(params = {}) {
  const key = params.key;
  if (!key) return "Error: key is required (e.g. 'enter', 'tab', 'escape', 'f5')";
  await sidecarPost("/desktop/keypress", { key });
  return `Pressed key: ${key}`;
}
