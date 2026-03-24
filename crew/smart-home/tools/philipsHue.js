/**
 * philipsHue - Control Philips Hue smart lights via local Bridge API.
 * Requires HUE_BRIDGE_IP and HUE_API_KEY env vars.
 * All requests go to the local bridge - no cloud dependency.
 */
import { resolveKey } from "./_env.js";
import { mergeLegacyParams as _mergeLegacy } from "../../../src/utils/mergeToolParams.js";

export async function philipsHue(_params) {
  const action = _params?.action;
  if (!action) return "Error: action required. Valid: list, on, off, color, brightness, scene, discover";
  const params = _mergeLegacy(_params);

  const bridgeIp = params.bridgeIp || resolveKey("HUE_BRIDGE_IP");
  const apiKey = params.apiKey || resolveKey("HUE_API_KEY");

  // Discovery doesn't require credentials
  if (action === "discover") {
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    try {
      const res = await fetchFn("https://discovery.meethue.com/");
      const data = await res.json();
      if (!data.length) return "No Hue bridges found on network";
      return data.map(b => `Bridge: ${b.id} at ${b.internalipaddress}`).join("\n");
    } catch (err) {
      return `Discovery error: ${err.message}`;
    }
  }

  if (!bridgeIp) return "Error: HUE_BRIDGE_IP env var or bridgeIp param required";
  if (!apiKey) return "Error: HUE_API_KEY env var or apiKey param required";

  const BASE = `http://${bridgeIp}/api/${apiKey}`;
  const fetchFn = globalThis.fetch || (await import("node-fetch")).default;

  const hueReq = async (method, path, body = null) => {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetchFn(`${BASE}${path}`, opts);
    return res.json();
  };

  if (action === "list") {
    const data = await hueReq("GET", "/lights");
    if (!data || typeof data !== "object") return "Error reading lights";
    const entries = Object.entries(data);
    if (!entries.length) return "No lights found";
    return entries.map(([id, light]) =>
      `[${id}] ${light.name} - ${light.state.on ? "ON" : "OFF"} - brightness: ${light.state.bri || "N/A"} - ${light.state.reachable ? "reachable" : "unreachable"}`
    ).join("\n");
  }

  const { lightId, groupId } = params;
  const targetPath = groupId
    ? `/groups/${groupId}/action`
    : lightId
    ? `/lights/${lightId}/state`
    : null;

  if (action === "on") {
    if (!targetPath) return "Error: lightId or groupId required";
    await hueReq("PUT", targetPath, { on: true });
    return `Light ${lightId || `group ${groupId}`} turned ON`;
  }

  if (action === "off") {
    if (!targetPath) return "Error: lightId or groupId required";
    await hueReq("PUT", targetPath, { on: false });
    return `Light ${lightId || `group ${groupId}`} turned OFF`;
  }

  if (action === "brightness") {
    if (!targetPath) return "Error: lightId or groupId required";
    const { level } = params;
    if (level === undefined) return "Error: level (0-254) required";
    const bri = Math.max(0, Math.min(254, Math.round(level)));
    await hueReq("PUT", targetPath, { on: true, bri });
    return `Brightness set to ${level} for light ${lightId || `group ${groupId}`}`;
  }

  if (action === "color") {
    if (!targetPath) return "Error: lightId or groupId required";
    const { hue, sat, bri, xy, colorTemp, hex } = params;

    let state = { on: true };

    if (hex) {
      // Convert hex to XY (approximate using CIE 1931 color space)
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      // Gamma correction
      const toLinear = c => c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
      const rL = toLinear(r), gL = toLinear(g), bL = toLinear(b);
      const X = rL * 0.664511 + gL * 0.154324 + bL * 0.162028;
      const Y = rL * 0.283881 + gL * 0.668433 + bL * 0.047685;
      const Z = rL * 0.000088 + gL * 0.072310 + bL * 0.986039;
      const sum = X + Y + Z || 1;
      state.xy = [X / sum, Y / sum];
      state.bri = Math.round(Y * 254);
    } else if (xy) {
      state.xy = xy;
    } else if (hue !== undefined) {
      state.hue = hue;
      if (sat !== undefined) state.sat = sat;
      if (bri !== undefined) state.bri = bri;
    } else if (colorTemp !== undefined) {
      state.ct = colorTemp; // Mired color temperature (153=cool, 500=warm)
    } else {
      return "Error: provide hex, xy, hue/sat, or colorTemp";
    }

    await hueReq("PUT", targetPath, state);
    return `Color set for light ${lightId || `group ${groupId}`}`;
  }

  if (action === "scene") {
    const { sceneId } = params;
    const gId = groupId || "0";
    if (!sceneId) {
      // List scenes
      const data = await hueReq("GET", "/scenes");
      const entries = Object.entries(data || {});
      if (!entries.length) return "No scenes found";
      return entries.map(([id, s]) => `[${id}] ${s.name}`).join("\n");
    }
    await hueReq("PUT", `/groups/${gId}/action`, { scene: sceneId });
    return `Scene "${sceneId}" activated`;
  }

  return `Unknown action: "${action}". Valid: list, on, off, brightness, color, scene, discover`;
}

export const philipsHueDescription =
  `philipsHue(action: string, paramsJson?: object) - Control Philips Hue smart lights via local bridge.
  action: "list" | "on" | "off" | "brightness" | "color" | "scene" | "discover"
  list: {} → shows all lights with status
  on/off: { lightId?: "1", groupId?: "1" }
  brightness: { lightId, level: 0-254 }
  color: { lightId, hex?: "#ff6600" | hue?: 0-65535, sat?: 0-254 | xy?: [x,y] | colorTemp?: 153-500 }
  scene: { groupId?, sceneId? } (omit sceneId to list scenes)
  discover: {} → finds bridges on local network
  Env vars: HUE_BRIDGE_IP, HUE_API_KEY
  Examples:
    philipsHue("list")
    philipsHue("on", {"lightId":"1"})
    philipsHue("color", {"lightId":"2","hex":"#ff6600"})
    philipsHue("brightness", {"groupId":"1","level":128})`;
