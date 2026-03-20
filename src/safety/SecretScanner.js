import eventBus from "../core/EventBus.js";

/**
 * Secret Scanner - detects and redacts sensitive data in tool I/O.
 *
 * Two complementary layers:
 *
 * 1. Pattern-based redaction — regex patterns for known secret formats
 *    (AWS keys, GitHub tokens, OpenAI keys, JWTs, connection strings, etc.)
 *
 * 2. Blind env-var redaction — at startup, collect all process.env values whose
 *    names look like secrets (contain _KEY, _TOKEN, _SECRET, etc.) and redact
 *    their exact values from any tool output. This catches custom tokens like
 *    TELEGRAM_BOT_TOKEN, TWILIO_AUTH_TOKEN, DISCORD_BOT_TOKEN that don't match
 *    any known format pattern.
 */

const SECRET_PATTERNS = [
  { name: "AWS Access Key",     pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "AWS Secret Key",     pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  { name: "Generic API Key",    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi },
  { name: "Generic Secret",     pattern: /(?:secret|password|passwd|pwd|token)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi },
  { name: "Private Key",        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: "GitHub Token",       pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { name: "Slack Token",        pattern: /xox[bprs]-[A-Za-z0-9\-]{10,}/g },
  { name: "OpenAI Key",         pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "Anthropic Key",      pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: "Google AI Key",      pattern: /AIza[A-Za-z0-9\-_]{35}/g },
  { name: "Telegram Token",     pattern: /\d{8,12}:[A-Za-z0-9_\-]{35}/g },
  { name: "Twilio SID",         pattern: /AC[a-f0-9]{32}/g },
  { name: "Bearer Token",       pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]{20,}/g },
  { name: "Connection String",  pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi },
  { name: "JWT",                pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

// ── Blind env-var redaction setup ─────────────────────────────────────────────
// Collect values of env vars whose NAMES suggest they hold secrets.
// Done once at module load — captures all secrets including ones that don't
// match any regex pattern above (e.g. DISCORD_BOT_TOKEN, LINE_CHANNEL_SECRET).
const SENSITIVE_NAME_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_PWD|_SID|_AUTH|_PRIVATE|_CREDENTIAL|_API|_WEBHOOK)$/i;

const _sensitiveEnvValues = new Set();
for (const [envKey, val] of Object.entries(process.env)) {
  if (val && val.length >= 8 && SENSITIVE_NAME_PATTERN.test(envKey)) {
    _sensitiveEnvValues.add(val);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

class SecretScanner {
  constructor() {
    this.detectionCount = 0;
  }

  /**
   * Re-scan process.env for sensitive values. Call after vault unlock,
   * config reload, or any operation that injects new secrets into process.env.
   */
  refreshSecrets() {
    let added = 0;
    for (const [envKey, val] of Object.entries(process.env)) {
      if (val && val.length >= 8 && SENSITIVE_NAME_PATTERN.test(envKey) && !_sensitiveEnvValues.has(val)) {
        _sensitiveEnvValues.add(val);
        added++;
      }
    }
    if (added > 0) console.log(`[SecretScanner] Refreshed — ${added} new secret(s) tracked (total: ${_sensitiveEnvValues.size})`);
    return added;
  }

  /**
   * Add new secret values to the blind redaction set at runtime.
   * Called by AgentLoop when tenant API keys are resolved.
   * @param {string[]} values
   */
  addKnownSecrets(values) {
    for (const v of values) {
      if (v && v.length >= 8) _sensitiveEnvValues.add(v);
    }
  }

  /**
   * Blind-redact exact env var values from text.
   * Handles secrets that don't match any regex pattern.
   * @param {string} text
   * @returns {{ redacted: string, count: number }}
   */
  _blindRedactEnv(text) {
    let out = text;
    let count = 0;
    for (const val of _sensitiveEnvValues) {
      if (out.includes(val)) {
        // Use split+join instead of replaceAll for safety with special regex chars
        out = out.split(val).join("[REDACTED:ENV_SECRET]");
        count++;
      }
    }
    return { redacted: out, count };
  }

  /**
   * Scan text for secrets and return findings.
   * @param {string} text - Text to scan
   * @returns {{ found: boolean, secrets: Array, redacted: string }}
   */
  scan(text) {
    if (!text || typeof text !== "string") {
      return { found: false, secrets: [], redacted: text };
    }

    const secrets = [];
    let redacted = text;

    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(text)) !== null) {
        const value = match[0];
        if (value.length < 8) continue;

        secrets.push({
          type: name,
          value: `${value.slice(0, 4)}...${value.slice(-4)}`,
          position: match.index,
        });

        redacted = redacted.split(value).join(`[REDACTED:${name}]`);
      }
    }

    if (secrets.length > 0) {
      this.detectionCount += secrets.length;
      eventBus.emitEvent("secret:detected", {
        count: secrets.length,
        types: [...new Set(secrets.map((s) => s.type))],
      });
    }

    return { found: secrets.length > 0, secrets, redacted };
  }

  /**
   * Scan and redact tool output before feeding back to agent.
   * Applies BOTH pattern-based AND blind env-var redaction.
   */
  redactOutput(text) {
    // Layer 1: pattern-based
    const result = this.scan(text);
    let out = result.redacted;

    // Layer 2: blind env-var values
    const { redacted: blindRedacted, count: blindCount } = this._blindRedactEnv(out);
    out = blindRedacted;

    const totalFound = result.secrets.length + blindCount;
    if (totalFound > 0) {
      const types = [
        ...result.secrets.map((s) => s.type),
        ...(blindCount > 0 ? [`ENV_SECRET(x${blindCount})`] : []),
      ];
      console.log(`      [SecretScanner] Redacted ${totalFound} secret(s): ${types.join(", ")}`);
      this.detectionCount += blindCount;
    }

    return out;
  }

  /**
   * Get detection stats.
   */
  stats() {
    return { totalDetections: this.detectionCount };
  }
}

const secretScanner = new SecretScanner();
export default secretScanner;
