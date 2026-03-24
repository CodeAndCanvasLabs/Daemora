import { config as loadEnv } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, copyFileSync } from "fs";
import { validateConfig } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");

// Auto-create .env from .env.example if it doesn't exist yet.
// This ensures npm-installed users get a working .env on first run.
const envPath = join(ROOT_DIR, ".env");
const examplePath = join(ROOT_DIR, ".env.example");
if (!existsSync(envPath) && existsSync(examplePath)) {
  copyFileSync(examplePath, envPath);
}

// Load .env from the module's install directory (ROOT_DIR), not process.cwd().
// This ensures `daemora start` always picks up the config written by `daemora setup`,
// regardless of which directory the user runs the command from.
loadEnv({ path: envPath, quiet: true });

// ── Config builder ────────────────────────────────────────────────────────────
// Pure function - takes an env map (process.env or override), returns validated config.
// Called on startup and again after reloadFromDb() injects SQLite config into process.env.

function buildConfig(env) {
  const raw = {
    // Server
    port: parseInt(env.PORT || "8081", 10),

    // Paths
    rootDir: ROOT_DIR,
    dataDir: join(ROOT_DIR, "data"),
    sessionsDir: join(ROOT_DIR, "data", "sessions"),
    tasksDir: join(ROOT_DIR, "data", "tasks"),
    memoryDir: join(ROOT_DIR, "data", "memory"),
    auditDir: join(ROOT_DIR, "data", "audit"),
    costsDir: join(ROOT_DIR, "data", "costs"),
    workspacesDir: join(ROOT_DIR, "data", "workspaces"),
    skillsDir: join(ROOT_DIR, "skills"),
    soulPath: join(ROOT_DIR, "SOUL.md"),
    memoryPath: join(ROOT_DIR, "MEMORY.md"),

    // Default model (provider:model format) - resolved at runtime by ModelRouter.resolveDefaultModel()
    // if not explicitly set. This placeholder is overridden after startup.
    defaultModel: env.DEFAULT_MODEL || null,

    // Sub-agent model - used for all sub-agents when no profile-specific model is set.
    subAgentModel: env.SUB_AGENT_MODEL || null,

    // Agent loop
    maxLoops: 100,
    maxSubAgentDepth: 3,

    // Thinking level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    thinkingLevel: env.THINKING_LEVEL || "auto",

    // Message queue mode: "steer" | "collect" | "followup"
    queueMode: env.QUEUE_MODE || "steer",
    debounceMs: parseInt(env.DEBOUNCE_MS || "1500", 10),

    // Safety
    permissionTier: env.PERMISSION_TIER || "standard",

    // Cost limits
    maxCostPerTask: parseFloat(env.MAX_COST_PER_TASK || "0.50"),
    maxDailyCost: parseFloat(env.MAX_DAILY_COST || "10.00"),

    // Auto-capture: log task summaries to daily log after each substantive task
    autoCapture: env.AUTO_CAPTURE !== "false",

    // Cleanup
    cleanupAfterDays: parseInt(env.CLEANUP_AFTER_DAYS || "30", 10),

    // Daemon
    daemonMode: env.DAEMON_MODE === "true",
    heartbeatIntervalMinutes: parseInt(env.HEARTBEAT_INTERVAL_MINUTES || "30", 10),

    // A2A Security
    a2a: {
      enabled: env.A2A_ENABLED === "true",
      authToken: env.A2A_AUTH_TOKEN || null,
      allowedAgents: env.A2A_ALLOWED_AGENTS
        ? env.A2A_ALLOWED_AGENTS.split(",").map((s) => s.trim())
        : [],
      permissionTier: env.A2A_PERMISSION_TIER || "minimal",
      maxCostPerTask: parseFloat(env.A2A_MAX_COST || "0.05"),
      rateLimitPerMinute: parseInt(env.A2A_RATE_LIMIT || "5", 10),
      blockedTools: ["executeCommand", "writeFile", "editFile", "sendEmail", "spawnAgent"],
    },

    // Filesystem sandboxing
    filesystem: {
      allowedPaths: env.ALLOWED_PATHS
        ? env.ALLOWED_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      blockedPaths: env.BLOCKED_PATHS
        ? env.BLOCKED_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      restrictCommands: env.RESTRICT_COMMANDS === "true",
    },

    // Multi-tenant configuration
    multiTenant: {
      enabled: env.MULTI_TENANT_ENABLED === "true",
      autoRegister: env.AUTO_REGISTER_TENANTS !== "false",
      isolateFilesystem: env.TENANT_ISOLATE_FILESYSTEM === "true",
    },

    // Sandbox
    sandbox: {
      mode: env.SANDBOX_MODE || "process",
      dockerImage: env.DOCKER_IMAGE || "node:22-alpine",
      dockerMemory: env.DOCKER_MEMORY || "512m",
      dockerCpus: env.DOCKER_CPUS || "0.5",
      dockerNetwork: env.DOCKER_NETWORK || "none",
    },

    // Channels
    channels: {
      http: { enabled: false },

      telegram: {
        enabled: !!env.TELEGRAM_BOT_TOKEN,
        token: env.TELEGRAM_BOT_TOKEN || null,
        allowlist: env.TELEGRAM_ALLOWLIST
          ? env.TELEGRAM_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.TELEGRAM_MODEL || null,
      },

      whatsapp: {
        enabled: !!env.TWILIO_ACCOUNT_SID,
        accountSid: env.TWILIO_ACCOUNT_SID || null,
        authToken: env.TWILIO_AUTH_TOKEN || null,
        from: env.TWILIO_WHATSAPP_FROM || null,
        allowlist: env.WHATSAPP_ALLOWLIST
          ? env.WHATSAPP_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.WHATSAPP_MODEL || null,
      },

      email: {
        enabled: !!(env.RESEND_API_KEY || env.EMAIL_USER),
        resendApiKey: env.RESEND_API_KEY || null,
        resendFrom:   env.RESEND_FROM   || null,
        imap: {
          host: env.EMAIL_IMAP_HOST || "imap.gmail.com",
          port: parseInt(env.EMAIL_IMAP_PORT || "993", 10),
        },
        smtp: {
          host: env.EMAIL_SMTP_HOST || "smtp.gmail.com",
          port: parseInt(env.EMAIL_SMTP_PORT || "587", 10),
        },
        user: env.EMAIL_USER     || null,
        password: env.EMAIL_PASSWORD || null,
        allowlist: env.EMAIL_ALLOWLIST
          ? env.EMAIL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.EMAIL_MODEL || null,
      },

      discord: {
        enabled: !!env.DISCORD_BOT_TOKEN,
        token: env.DISCORD_BOT_TOKEN || null,
        allowlist: env.DISCORD_ALLOWLIST
          ? env.DISCORD_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.DISCORD_MODEL || null,
      },

      slack: {
        enabled: !!(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN),
        botToken: env.SLACK_BOT_TOKEN || null,
        appToken: env.SLACK_APP_TOKEN || null,
        allowlist: env.SLACK_ALLOWLIST
          ? env.SLACK_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.SLACK_MODEL || null,
      },

      line: {
        enabled: !!(env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET),
        accessToken: env.LINE_CHANNEL_ACCESS_TOKEN || null,
        channelSecret: env.LINE_CHANNEL_SECRET || null,
        allowlist: env.LINE_ALLOWLIST
          ? env.LINE_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.LINE_MODEL || null,
      },

      signal: {
        enabled: !!(env.SIGNAL_CLI_URL && env.SIGNAL_PHONE_NUMBER),
        cliUrl: env.SIGNAL_CLI_URL || null,
        phoneNumber: env.SIGNAL_PHONE_NUMBER || null,
        allowlist: env.SIGNAL_ALLOWLIST
          ? env.SIGNAL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.SIGNAL_MODEL || null,
      },

      teams: {
        enabled: !!(env.TEAMS_APP_ID && env.TEAMS_APP_PASSWORD),
        appId: env.TEAMS_APP_ID || null,
        appPassword: env.TEAMS_APP_PASSWORD || null,
        allowlist: env.TEAMS_ALLOWLIST
          ? env.TEAMS_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.TEAMS_MODEL || null,
      },

      googlechat: {
        enabled: !!env.GOOGLE_CHAT_SERVICE_ACCOUNT,
        serviceAccount: env.GOOGLE_CHAT_SERVICE_ACCOUNT || null,
        projectNumber: env.GOOGLE_CHAT_PROJECT_NUMBER || null,
        allowlist: env.GOOGLE_CHAT_ALLOWLIST
          ? env.GOOGLE_CHAT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        model: env.GOOGLE_CHAT_MODEL || null,
      },
    },
  };

  const { ok, data, issues } = validateConfig(raw);
  if (!ok) {
    console.error("\n[Config] Invalid configuration:\n");
    for (const { path, message } of issues) {
      console.error(`  - "${path}": ${message}`);
    }
    console.error("");
    process.exit(1);
  }
  return data;
}

// Initial build from process.env (populated from .env by dotenv above)
export const config = buildConfig(process.env);

// ── Runtime reload from SQLite ────────────────────────────────────────────────
/**
 * Reload config from SQLite config_entries table.
 *
 * Call this after vault unlock + secret injection so SQLite config values
 * (channel tokens, model settings, etc.) take effect before channels start.
 *
 * config_entries values override .env values - SQLite is the source of truth.
 * process.env is NOT cleared first, so any .env values not in SQLite are kept.
 *
 * Uses dynamic import to avoid circular dependency with Database.js.
 */
// Keys that belong in the vault, not in config_entries.
// If any of these leak into config_entries, they are deleted on reload.
const SENSITIVE_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL/i;

export async function reloadFromDb() {
  try {
    const { getDb } = await import("../storage/Database.js");
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM config_entries").all();
    if (rows.length === 0) return;

    // Check if vault is active - if so, skip sensitive keys from config_entries
    // to prevent stale/plaintext values from overwriting decrypted vault secrets.
    let vaultActive = false;
    try {
      const vault = (await import("../safety/SecretVault.js")).default;
      vaultActive = vault.isUnlocked();
    } catch { /* vault module not available - treat as inactive */ }

    let loaded = 0;
    const leaked = [];
    for (const { key, value } of rows) {
      // Skip sensitive keys when vault is active - vault is source of truth.
      // Exception: WEBHOOK_TOKEN is auto-generated config, not a vault secret.
      if (vaultActive && SENSITIVE_PATTERN.test(key) && key !== "WEBHOOK_TOKEN") {
        leaked.push(key);
        continue; // skip - vault has the real decrypted value
      }
      process.env[key] = value;
      loaded++;
    }

    // Clean up any sensitive keys that leaked into config_entries
    if (leaked.length > 0) {
      const del = db.prepare("DELETE FROM config_entries WHERE key = ?");
      for (const key of leaked) del.run(key);
      console.log(`[Config] Removed ${leaked.length} sensitive key(s) from config_entries (vault is source of truth): ${leaked.join(", ")}`);
    }

    // Rebuild and merge into the exported config object in-place.
    // All existing references to `config` see the updated values.
    const updated = buildConfig(process.env);
    Object.assign(config, updated);

    console.log(`[Config] Reloaded ${loaded} setting(s) from SQLite`);
  } catch (err) {
    console.log(`[Config] SQLite reload skipped: ${err.message}`);
  }
}
