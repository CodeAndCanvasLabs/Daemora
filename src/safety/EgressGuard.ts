/**
 * EgressGuard — scans outbound HTTP (URL, headers, body) for leaked
 * secrets before the request actually fires.
 *
 * Complements SecretScanner (which redacts inbound tool output). Here
 * we fail-closed: if a request body contains a tracked secret value,
 * the caller sees `{ safe: false, leakedFromEnv }` and can abort the
 * request rather than ship credentials to some third-party URL the
 * agent was told to call.
 *
 * Secrets are tracked by value (8+ chars) so we don't false-positive
 * on tiny strings like `NODE_ENV=dev`.
 */

import { createLogger } from "../util/logger.js";

const log = createLogger("egress-guard");

const SENSITIVE_NAME_PATTERN =
  /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_SID|_PRIVATE|_PASSPHRASE)$/i;

const MIN_SECRET_LEN = 8;

export interface EgressCheck {
  readonly safe: boolean;
  /** Env-var name (or "TRACKED") the leaked value came from — for logs. */
  readonly leakedFromEnv?: string;
}

export class EgressGuard {
  private readonly secrets = new Map<string, string>(); // value → source-name
  private enabled = true;

  constructor() {
    this.refreshFromEnv();
  }

  /** Re-snapshot sensitive env-var values. Call after vault unlock / reload. */
  refreshFromEnv(): number {
    let added = 0;
    for (const [k, v] of Object.entries(process.env)) {
      if (!v) continue;
      if (v.length < MIN_SECRET_LEN) continue;
      if (!SENSITIVE_NAME_PATTERN.test(k)) continue;
      if (this.secrets.has(v)) continue;
      this.secrets.set(v, k);
      added++;
    }
    if (added > 0) log.info({ added, total: this.secrets.size }, "egress guard refreshed from env");
    return added;
  }

  /** Add known secret values — e.g. vault keys after unlock. */
  addSecrets(values: readonly string[], sourceLabel = "TRACKED"): void {
    for (const v of values) {
      if (v && v.length >= MIN_SECRET_LEN && !this.secrets.has(v)) {
        this.secrets.set(v, sourceLabel);
      }
    }
  }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }

  /** Does `data` contain any tracked secret value? */
  check(data: string | undefined | null): EgressCheck {
    if (!this.enabled || !data || typeof data !== "string") return { safe: true };
    for (const [value, source] of this.secrets.entries()) {
      if (data.includes(value)) {
        log.warn({ source }, "egress guard caught a tracked secret in outbound data");
        return { safe: false, leakedFromEnv: source };
      }
    }
    return { safe: true };
  }

  /** Convenience: check URL + body together in one call. */
  checkRequest(url: string, body?: unknown, headers?: Record<string, string>): EgressCheck {
    const urlResult = this.check(url);
    if (!urlResult.safe) return urlResult;
    if (body !== undefined && body !== null) {
      const bodyStr = typeof body === "string" ? body : safeStringify(body);
      const bodyResult = this.check(bodyStr);
      if (!bodyResult.safe) return bodyResult;
    }
    if (headers) {
      for (const val of Object.values(headers)) {
        const headerResult = this.check(val);
        if (!headerResult.safe) return headerResult;
      }
    }
    return { safe: true };
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const egressGuard = new EgressGuard();
