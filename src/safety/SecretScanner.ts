/**
 * SecretScanner — detects and redacts sensitive data in tool I/O.
 *
 * Two complementary layers:
 *
 *   1. **Pattern-based redaction** — regex patterns for well-known
 *      secret formats (AWS keys, GitHub tokens, OpenAI / Anthropic /
 *      Google AI keys, JWTs, connection strings, Telegram bot tokens,
 *      and so on). Matches are replaced with `[REDACTED:<kind>]`.
 *
 *   2. **Blind value redaction** — at startup (and on demand) we snapshot
 *      every value of env vars whose *name* looks secret-y (`*_TOKEN`,
 *      `*_KEY`, `*_SECRET`, …) and any keys pulled out of the vault.
 *      Those exact strings are stripped from tool output, so we catch
 *      provider tokens that don't match any regex above
 *      (DISCORD_BOT_TOKEN, LINE_CHANNEL_SECRET, custom webhooks, …).
 *
 * Exposes a singleton (`secretScanner`) so channels / tool runners share
 * detection counts and the blind-redaction set across the process.
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";

const log = createLogger("secret-scanner");

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Minimum match length before we treat it as a secret — avoids catching short env values. */
const MIN_SECRET_LEN = 8;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "AWS Access Key",      pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "AWS Secret Key",      pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  { name: "Generic API Key",     pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi },
  { name: "Generic Secret",      pattern: /(?:secret|password|passwd|pwd|token)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi },
  { name: "Private Key",         pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: "GitHub Token",        pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { name: "Slack Token",         pattern: /xox[bprs]-[A-Za-z0-9\-]{10,}/g },
  { name: "OpenAI Key",          pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "Anthropic Key",       pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: "Google AI Key",       pattern: /AIza[A-Za-z0-9\-_]{35}/g },
  { name: "Telegram Token",      pattern: /\d{8,12}:[A-Za-z0-9_\-]{35}/g },
  { name: "Twilio SID",          pattern: /AC[a-f0-9]{32}/g },
  { name: "Bearer Token",        pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]{20,}/g },
  { name: "Connection String",   pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi },
  { name: "JWT",                 pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const SENSITIVE_NAME_PATTERN =
  /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_PWD|_SID|_AUTH|_PRIVATE|_CREDENTIAL|_API|_WEBHOOK)$/i;

export interface SecretMatch {
  readonly type: string;
  /** First / last 4 chars of the matched value — never the full secret. */
  readonly preview: string;
  readonly position: number;
}

export interface ScanResult {
  readonly found: boolean;
  readonly secrets: readonly SecretMatch[];
  readonly redacted: string;
}

export class SecretScanner extends EventEmitter {
  private detectionCount = 0;
  private readonly blindValues = new Set<string>();

  constructor() {
    super();
    this.refreshFromEnv();
  }

  /**
   * Re-scan process.env for sensitive values. Call after vault unlock,
   * config reload, or any operation that injects new secrets into env.
   */
  refreshFromEnv(): number {
    let added = 0;
    for (const [key, val] of Object.entries(process.env)) {
      if (!val) continue;
      if (val.length < MIN_SECRET_LEN) continue;
      if (!SENSITIVE_NAME_PATTERN.test(key)) continue;
      if (this.blindValues.has(val)) continue;
      this.blindValues.add(val);
      added++;
    }
    if (added > 0) log.info({ added, total: this.blindValues.size }, "env secrets refreshed");
    return added;
  }

  /**
   * Add known secret values for blind redaction — e.g. vault keys after
   * unlock, or API keys resolved for a particular tool call.
   */
  addKnownSecrets(values: readonly string[]): void {
    for (const v of values) {
      if (v && v.length >= MIN_SECRET_LEN) this.blindValues.add(v);
    }
  }

  /** How many blind values are currently tracked. */
  get trackedCount(): number {
    return this.blindValues.size;
  }

  /**
   * Scan text using pattern-based detection only. Returns the scan
   * result with a redacted copy.
   */
  scan(text: string): ScanResult {
    if (!text || typeof text !== "string") {
      return { found: false, secrets: [], redacted: text ?? "" };
    }

    const secrets: SecretMatch[] = [];
    let redacted = text;

    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const value = match[0];
        if (value.length < MIN_SECRET_LEN) continue;
        secrets.push({
          type: name,
          preview: `${value.slice(0, 4)}...${value.slice(-4)}`,
          position: match.index,
        });
        redacted = redacted.split(value).join(`[REDACTED:${name}]`);
      }
    }

    if (secrets.length > 0) {
      this.detectionCount += secrets.length;
      this.emit("detected", {
        count: secrets.length,
        types: [...new Set(secrets.map((s) => s.type))],
      });
    }

    return { found: secrets.length > 0, secrets, redacted };
  }

  /**
   * Scan + redact with both layers (pattern + blind env values). The
   * preferred entry point for redacting tool output before it re-enters
   * the agent loop.
   */
  redact(text: string): string {
    if (!text || typeof text !== "string") return text ?? "";
    const patternResult = this.scan(text);
    let out = patternResult.redacted;
    let blindCount = 0;
    for (const val of this.blindValues) {
      if (!out.includes(val)) continue;
      out = out.split(val).join("[REDACTED:ENV_SECRET]");
      blindCount++;
    }
    if (blindCount > 0) {
      this.detectionCount += blindCount;
      log.info({ patterns: patternResult.secrets.length, blind: blindCount }, "secrets redacted");
    }
    return out;
  }

  stats(): { totalDetections: number; trackedCount: number } {
    return { totalDetections: this.detectionCount, trackedCount: this.blindValues.size };
  }
}

/** Process-wide singleton — shared by tool runners, channels, audit log. */
export const secretScanner = new SecretScanner();
