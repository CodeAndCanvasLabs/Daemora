/**
 * TunnelManager — auto-exposes local server for Twilio webhooks.
 *
 * Priority:
 *   1. DAEMORA_PUBLIC_URL / SERVER_URL set → use as-is (production)
 *   2. NGROK_AUTHTOKEN set → auto-start ngrok tunnel (dev)
 *   3. Otherwise → log instructions, no tunnel
 *
 * Sets process.env.DAEMORA_PUBLIC_URL + VOICE_WEBHOOK_BASE_URL.
 */

let _tunnel = null;

/**
 * Start tunnel if DAEMORA_PUBLIC_URL not already configured.
 * @param {number} port
 * @returns {Promise<string>} resolved public URL
 */
export async function ensurePublicUrl(port) {
  const existing = process.env.DAEMORA_PUBLIC_URL || process.env.SERVER_URL;
  if (existing) {
    process.env.VOICE_WEBHOOK_BASE_URL = process.env.VOICE_WEBHOOK_BASE_URL || existing;
    console.log(`[Tunnel] Public URL: ${existing} (from config)`);
    return existing;
  }

  // ngrok — reliable, no interstitial, works with Twilio
  if (process.env.NGROK_AUTHTOKEN) {
    try {
      const ngrok = await import("@ngrok/ngrok");
      const listener = await ngrok.default.forward({
        addr: port,
        authtoken: process.env.NGROK_AUTHTOKEN,
      });
      const url = listener.url();
      _tunnel = { type: "ngrok", listener };
      process.env.DAEMORA_PUBLIC_URL = url;
      process.env.VOICE_WEBHOOK_BASE_URL = url;
      console.log(`[Tunnel] ngrok: ${url}`);
      return url;
    } catch (e) {
      console.log(`[Tunnel] ngrok failed: ${e.message}`);
    }
  }

  // No tunnel — print instructions
  console.log("[Tunnel] No public URL configured. Voice calls & meetings won't work.");
  console.log("[Tunnel] Options:");
  console.log("[Tunnel]   Production → set DAEMORA_PUBLIC_URL=https://your-server.com");
  console.log("[Tunnel]   Local dev  → set NGROK_AUTHTOKEN (free at ngrok.com)");
  return "";
}

/**
 * Close the active tunnel on shutdown.
 */
export async function closeTunnel() {
  if (!_tunnel) return;
  try {
    if (_tunnel.type === "ngrok") await _tunnel.listener.close();
  } catch {}
  _tunnel = null;
}
