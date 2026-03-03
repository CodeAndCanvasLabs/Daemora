/**
 * CommandGuard — blocks shell commands that could expose secrets or exfiltrate data.
 *
 * Called by executeCommand() before running any shell command.
 * This is defence-in-depth — it runs AFTER filesystem scoping and BEFORE SecretScanner.
 *
 * Blocked categories:
 *   1. Environment dumping    — printenv, /proc/self/environ, etc.
 *   2. .env file access       — cat/less/head/tail .env via shell
 *   3. Targeted env access    — node -e 'process.env.KEY', python -c 'os.environ'
 *   4. Credential exfiltration — curl/wget with $API_KEY or $(printenv ...) in URL/body
 *   5. Sensitive file reads   — reading vault, tenant data, ssh keys via shell
 */

import eventBus from "../core/EventBus.js";

const BLOCKED_COMMANDS = [
  // ── 1. Environment dumping ────────────────────────────────────────────────
  {
    pattern: /\bprintenv\b/i,
    reason: "printenv dumps all environment variables and is blocked. Environment variables may contain API keys.",
  },
  {
    pattern: /\/proc\/self\/environ/,
    reason: "Reading /proc/self/environ to access the process environment is blocked.",
  },
  {
    // Block `env` only when used alone or followed by flags (not `env VAR=x cmd`)
    // Allows: NODE_ENV=test node ..., env -i CMD (clearing env)
    // Blocks: env, env | grep, env > file, env ; something
    pattern: /(?:^|[;&|`]\s*)env\s*(?:$|[|>&;`\n])/,
    reason: "Dumping the process environment with bare 'env' is blocked.",
  },

  // ── 2. .env file access via shell ─────────────────────────────────────────
  {
    pattern: /\b(?:cat|less|more|head|tail|bat|view|nano|vi|vim|emacs|open|code|subl)\b[^;|&\n]*\.env(?:\.[^\s;&|]*)?(?:\s|$)/i,
    reason: "Reading .env files via shell is blocked. These files contain API keys.",
  },
  {
    // Detect: cp .env /tmp/..., mv .env ..., tar -cf ... .env, zip ... .env
    pattern: /\b(?:cp|mv|rsync|scp|tar|zip|gzip)\b[^;|&\n]*\.env(?:\.[^\s;&|]*)?(?:\s|$)/i,
    reason: "Copying or archiving .env files is blocked.",
  },

  // ── 3. Targeted env access via interpreters ───────────────────────────────
  {
    pattern: /\bnode\b[^;|&\n]*(?:-e|--eval)\s+['"][^'"]*process\.env/i,
    reason: "Accessing process.env via node -e is blocked.",
  },
  {
    pattern: /\bnode\b[^;|&\n]*(?:-e|--eval)\s+['"][^'"]*require\s*\(\s*['"]dotenv/i,
    reason: "Loading .env via node -e + dotenv is blocked.",
  },
  {
    pattern: /\bpython[23]?\b[^;|&\n]*-c\s+['"][^'"]*(?:os\.environ|os\.getenv|dotenv)/i,
    reason: "Accessing environment variables via python -c is blocked.",
  },
  {
    pattern: /\bruby\b[^;|&\n]*-e\s+['"][^'"]*ENV\[/i,
    reason: "Accessing environment variables via ruby -e is blocked.",
  },

  // ── 4. Credential exfiltration patterns ──────────────────────────────────
  {
    // curl/wget with a shell-expanded env var in the URL or data
    pattern: /\b(?:curl|wget)\b[^;|&\n]*\$(?:\{[A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|SID|AUTH|PRIVATE)[^}]*\}|[A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|SID|AUTH|PRIVATE)\b)/i,
    reason: "Potential credential exfiltration: environment variable containing a secret appears in a curl/wget command.",
  },
  {
    // curl/wget with $(printenv ...) or $(env ...) substitution
    pattern: /\b(?:curl|wget|nc|netcat|http|httpie)\b[^;|&\n]*\$\(\s*(?:printenv|env)\b/i,
    reason: "Potential credential exfiltration: curl/wget combined with printenv/env is blocked.",
  },
  {
    // Piping printenv output to anything external
    pattern: /\bprintenv\b[^;|&\n]*\|\s*(?:curl|wget|nc|netcat|tee|mail|sendmail)/i,
    reason: "Piping environment variables to an external destination is blocked.",
  },
  {
    // Redirecting env to a file for later exfiltration
    pattern: /\bprintenv\b[^;|&\n]*>/,
    reason: "Redirecting environment variable dump to a file is blocked.",
  },

  // ── 5. Sensitive file reads via shell ─────────────────────────────────────
  {
    pattern: /\b(?:cat|less|more|head|tail)\b[^;|&\n]*(?:\.vault\.enc|\.vault\.salt|tenants\.json|\/data\/tenants\/)/i,
    reason: "Reading vault or tenant data files via shell is blocked.",
  },
  {
    pattern: /\b(?:cat|less|more|head|tail)\b[^;|&\n]*(?:id_rsa|id_ed25519|id_ecdsa|\.pem|\.key)\b/i,
    reason: "Reading private key files via shell is blocked.",
  },
  // ── 6. Agent config files (may contain plaintext MCP API keys) ────────────
  {
    // config/mcp.json contains GITHUB_TOKEN, Bearer tokens, etc. in plaintext
    pattern: /\b(?:cat|less|more|head|tail|bat|jq|python|node)\b[^;|&\n]*config[\/\\]mcp\.json/i,
    reason: "Reading config/mcp.json via shell is blocked — it may contain MCP server API keys.",
  },
  {
    pattern: /\b(?:cat|less|more|head|tail|bat)\b[^;|&\n]*config[\/\\]hooks\.json/i,
    reason: "Reading config/hooks.json via shell is blocked.",
  },
  {
    // Also block direct JSON parsing of mcp.json to extract credentials
    pattern: /config[\/\\]mcp\.json[^;|&\n]*(?:\||>)/,
    reason: "Piping or redirecting config/mcp.json is blocked — it may contain MCP server API keys.",
  },
];

/**
 * Check a shell command before execution.
 * @param {string} cmd
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return { allowed: true };

  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    // Reset stateful regex
    if (pattern.global) pattern.lastIndex = 0;

    if (pattern.test(cmd)) {
      eventBus.emitEvent("command:blocked", { cmd: cmd.slice(0, 200), reason });
      console.log(`      [CommandGuard] Blocked: ${reason}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}
