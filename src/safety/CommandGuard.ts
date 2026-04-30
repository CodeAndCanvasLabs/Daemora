/**
 * CommandGuard — blocks shell commands that could exfiltrate secrets,
 * escalate privilege, or read the agent's own config files.
 *
 * Called before any `execute_command` tool invocation. This is
 * defence-in-depth; it sits BEFORE the actual spawn and AFTER the
 * FilesystemGuard path check, and complements SecretScanner's
 * post-hoc output redaction.
 *
 * Blocked categories (from JS parity):
 *   1. Environment dumping   — `printenv`, `/proc/self/environ`, bare `env`.
 *   2. `.env` file reads     — cat/less/head/tail/open/bat on `.env*`.
 *   3. Env access via interpreters — node -e `process.env`, python -c `os.environ`, etc.
 *   4. Credential exfiltration — curl/wget with `$API_KEY`, piping env to
 *      external hosts, redirecting env dumps to files.
 *   5. Sensitive file reads — vault files, tenant data, SSH private keys.
 *   6. Daemora CLI privilege escalation — agent must never run its own CLI.
 *   7. Agent config files   — `config/mcp.json`, `config/hooks.json` (often
 *      hold provider tokens in plaintext).
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";

const log = createLogger("command-guard");

interface BlockRule {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly category: string;
}

const BLOCKED_COMMANDS: readonly BlockRule[] = [
  // 1. Environment dumping
  { category: "env-dump", pattern: /\bprintenv\b/i, reason: "printenv dumps all environment variables and is blocked." },
  { category: "env-dump", pattern: /\/proc\/self\/environ/, reason: "Reading /proc/self/environ is blocked." },
  {
    category: "env-dump",
    pattern: /(?:^|[;&|`]\s*)env\s*(?:$|[|>&;`\n])/,
    reason: "Bare 'env' command (dumps environment) is blocked.",
  },

  // 2. .env file access via shell
  {
    category: "dotenv",
    pattern: /\b(?:cat|less|more|head|tail|bat|view|nano|vi|vim|emacs|open|code|subl)\b[^;|&\n]*\.env(?:\.[^\s;&|]*)?(?:\s|$)/i,
    reason: "Reading .env files via shell is blocked.",
  },
  {
    category: "dotenv",
    pattern: /\b(?:cp|mv|rsync|scp|tar|zip|gzip)\b[^;|&\n]*\.env(?:\.[^\s;&|]*)?(?:\s|$)/i,
    reason: "Copying / archiving .env files is blocked.",
  },

  // 3. Env access via interpreters
  {
    category: "interpreter-env",
    pattern: /\bnode\b[^;|&\n]*(?:-e|--eval)\s+['"][^'"]*process\.env/i,
    reason: "Accessing process.env via node -e is blocked.",
  },
  {
    category: "interpreter-env",
    pattern: /\bnode\b[^;|&\n]*(?:-e|--eval)\s+['"][^'"]*require\s*\(\s*['"]dotenv/i,
    reason: "Loading .env via node -e + dotenv is blocked.",
  },
  {
    category: "interpreter-env",
    pattern: /\bpython[23]?\b[^;|&\n]*-c\s+['"][^'"]*(?:os\.environ|os\.getenv|dotenv)/i,
    reason: "Accessing environment via python -c is blocked.",
  },
  {
    category: "interpreter-env",
    pattern: /\bruby\b[^;|&\n]*-e\s+['"][^'"]*ENV\[/i,
    reason: "Accessing environment via ruby -e is blocked.",
  },

  // 4. Credential exfiltration
  {
    category: "exfil",
    pattern: /\b(?:curl|wget)\b[^;|&\n]*\$(?:\{[A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|SID|AUTH|PRIVATE)[^}]*\}|[A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|SID|AUTH|PRIVATE)\b)/i,
    reason: "Potential credential exfiltration: env var containing a secret inside curl/wget.",
  },
  {
    category: "exfil",
    pattern: /\b(?:curl|wget|nc|netcat|http|httpie)\b[^;|&\n]*\$\(\s*(?:printenv|env)\b/i,
    reason: "Potential exfiltration: curl/wget combined with printenv/env.",
  },
  {
    category: "exfil",
    pattern: /\bprintenv\b[^;|&\n]*\|\s*(?:curl|wget|nc|netcat|tee|mail|sendmail)/i,
    reason: "Piping env to an external destination is blocked.",
  },
  {
    category: "exfil",
    pattern: /\bprintenv\b[^;|&\n]*>/,
    reason: "Redirecting env dump to a file is blocked.",
  },

  // 5. Sensitive file reads
  {
    category: "sensitive-read",
    pattern: /\b(?:cat|less|more|head|tail)\b[^;|&\n]*(?:\.vault\.enc|\.vault\.salt|tenants\.json|\/data\/tenants\/)/i,
    reason: "Reading vault / tenant data via shell is blocked.",
  },
  {
    category: "sensitive-read",
    pattern: /\b(?:cat|less|more|head|tail)\b[^;|&\n]*(?:id_rsa|id_ed25519|id_ecdsa|\.pem|\.key)\b/i,
    reason: "Reading SSH / TLS private keys is blocked.",
  },

  // 6. Daemora CLI privilege escalation
  {
    category: "privesc",
    pattern: /(?:^|[;&|`]\s*)(?:daemora|aegis)\b/,
    reason: "Running daemora/aegis CLI from inside the agent is blocked (privilege escalation).",
  },
  {
    category: "privesc",
    pattern: /\bnpx\s+(?:daemora|aegis)\b/,
    reason: "Running daemora/aegis via npx is blocked (privilege escalation).",
  },
  {
    category: "privesc",
    pattern: /\bnode\b[^;|&\n]*(?:cli\.js|bin\/daemora|bin\/aegis)\b/,
    reason: "Running daemora/aegis CLI via node is blocked.",
  },
  {
    category: "privesc",
    pattern: /\bbash\b[^;|&\n]*-c\s+['"][^'"]*(?:daemora|aegis)\b/,
    reason: "Running daemora/aegis via bash -c is blocked.",
  },

  // 7. Agent-owned config files
  {
    category: "config",
    pattern: /\b(?:cat|less|more|head|tail|bat|jq|python|node)\b[^;|&\n]*config[\/\\]mcp\.json/i,
    reason: "Reading config/mcp.json (MCP server credentials) is blocked.",
  },
  {
    category: "config",
    pattern: /\b(?:cat|less|more|head|tail|bat)\b[^;|&\n]*config[\/\\]hooks\.json/i,
    reason: "Reading config/hooks.json is blocked.",
  },
  {
    category: "config",
    pattern: /config[\/\\]mcp\.json[^;|&\n]*(?:\||>)/,
    reason: "Piping/redirecting config/mcp.json is blocked.",
  },

  // 8. Agent's own SQLite DB — user rule: "must not read its own DB"
  {
    category: "self-db",
    pattern: /\bdaemora\.db(?:-(?:wal|shm))?\b/i,
    reason: "Reading the Daemora SQLite database via shell is blocked.",
  },
];

export interface CommandCheck {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly category?: string;
}

export class CommandGuard extends EventEmitter {
  /** Run a single command string through every rule. First match wins. */
  check(cmd: string): CommandCheck {
    if (!cmd || typeof cmd !== "string") return { allowed: true };
    for (const rule of BLOCKED_COMMANDS) {
      if (rule.pattern.test(cmd)) {
        log.warn({ category: rule.category, cmd: cmd.slice(0, 160) }, "command blocked");
        this.emit("blocked", { category: rule.category, reason: rule.reason, cmd: cmd.slice(0, 200) });
        return { allowed: false, reason: rule.reason, category: rule.category };
      }
    }
    return { allowed: true };
  }
}

export const commandGuard = new CommandGuard();
