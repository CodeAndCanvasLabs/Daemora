/**
 * Shared HTTP client for the Daemora desktop sidecar.
 * All desktop-control tools route through this helper.
 */

const DEFAULT_URL = "http://127.0.0.1:8765";

function baseUrl() {
  return process.env.DESKTOP_SIDECAR_URL
    || process.env.CREW_DESKTOP_CONTROL_SIDECAR_URL
    || DEFAULT_URL;
}

function token() {
  return process.env.DESKTOP_SIDECAR_TOKEN
    || process.env.CREW_DESKTOP_CONTROL_SIDECAR_TOKEN
    || "";
}

export async function sidecarPost(path, body = {}) {
  const url = `${baseUrl()}${path}`;
  const headers = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers["X-Daemora-Token"] = t;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Desktop sidecar unreachable at ${url}. Start the Daemora desktop app, or run the sidecar manually: \`python -m daemora_sidecar.main\`. Error: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.detail || data.error || text || `HTTP ${res.status}`;
    throw new Error(`Sidecar ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

export async function sidecarGet(path) {
  const url = `${baseUrl()}${path}`;
  const headers = {};
  const t = token();
  if (t) headers["X-Daemora-Token"] = t;
  let res;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (e) {
    throw new Error(`Desktop sidecar unreachable at ${url}. Error: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.detail || data.error || text || `HTTP ${res.status}`;
    throw new Error(`Sidecar ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

export async function sidecarHealth() {
  return sidecarGet("/health");
}
