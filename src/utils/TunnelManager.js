/**
 * TunnelManager — auto-exposes local server via localtunnel when DAEMORA_PUBLIC_URL is not set.
 *
 * Priority:
 *   1. DAEMORA_PUBLIC_URL set → use as-is
 *   2. NGROK_AUTHTOKEN set → use @ngrok/ngrok SDK
 *   3. Otherwise → localtunnel (free, no account)
 *
 * Sets process.env.DAEMORA_PUBLIC_URL so PhoneMeetingBot + Twilio webhooks pick it up.
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
    console.log(`[Tunnel] Public URL: ${existing} (from config)`);
    return existing;
  }

  // Try ngrok first if authtoken is available
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
      console.log(`[Tunnel] ngrok tunnel: ${url}`);
      return url;
    } catch (e) {
      console.log(`[Tunnel] ngrok failed: ${e.message} — falling back to localtunnel`);
    }
  }

  // localtunnel — free, no account
  try {
    const { default: localtunnel } = await import("localtunnel");
    const tunnel = await localtunnel({ port });
    _tunnel = { type: "localtunnel", tunnel };
    process.env.DAEMORA_PUBLIC_URL = tunnel.url;
    console.log(`[Tunnel] localtunnel: ${tunnel.url}`);

    tunnel.on("close", () => {
      console.log("[Tunnel] localtunnel closed");
      process.env.DAEMORA_PUBLIC_URL = "";
      process.env.VOICE_WEBHOOK_BASE_URL = "";
    });
    tunnel.on("error", (e) => {
      console.log(`[Tunnel] localtunnel error: ${e.message}`);
    });

    return tunnel.url;
  } catch (e) {
    console.log(`[Tunnel] localtunnel failed: ${e.message}`);
    console.log("[Tunnel] Set DAEMORA_PUBLIC_URL manually if you need Twilio meetings.");
    return "";
  }
}

/**
 * Close the active tunnel on shutdown.
 */
export async function closeTunnel() {
  if (!_tunnel) return;
  try {
    if (_tunnel.type === "ngrok") await _tunnel.listener.close();
    if (_tunnel.type === "localtunnel") _tunnel.tunnel.close();
  } catch {}
  _tunnel = null;
}
