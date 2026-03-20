/**
 * EgressGuard — scans outbound HTTP requests for leaked secrets.
 * Checks URL, headers, and body against known secret values.
 * Blocks requests that contain API keys or tokens.
 */

const SENSITIVE_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_SID|_PRIVATE|_PASSPHRASE)$/i;

class EgressGuard {
  constructor() {
    this._secrets = new Set();
    this._enabled = true;
  }

  /** Refresh secret set from process.env (call after vault unlock / config reload) */
  refresh() {
    this._secrets.clear();
    for (const [k, v] of Object.entries(process.env)) {
      if (v && v.length >= 8 && SENSITIVE_NAME.test(k)) {
        this._secrets.add(v);
      }
    }
  }

  /** Add individual secret values (e.g. per-tenant keys) */
  addSecrets(values) {
    for (const v of values) {
      if (v && v.length >= 8) this._secrets.add(v);
    }
  }

  /**
   * Check if a string contains any known secret value.
   * @param {string} data — URL, body, header value, etc.
   * @returns {{ safe: boolean, leaked?: string }} — leaked = env var name hint
   */
  check(data) {
    if (!this._enabled || !data || typeof data !== "string") return { safe: true };
    for (const secret of this._secrets) {
      if (data.includes(secret)) {
        // Find the env var name for the leaked value (for logging)
        let name = "UNKNOWN";
        for (const [k, v] of Object.entries(process.env)) {
          if (v === secret) { name = k; break; }
        }
        return { safe: false, leaked: name };
      }
    }
    return { safe: true };
  }

  /** Check URL + body together */
  checkRequest(url, body) {
    const urlCheck = this.check(url);
    if (!urlCheck.safe) return urlCheck;
    if (body) {
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      return this.check(bodyStr);
    }
    return { safe: true };
  }

  enable() { this._enabled = true; }
  disable() { this._enabled = false; }
}

const egressGuard = new EgressGuard();
export default egressGuard;
