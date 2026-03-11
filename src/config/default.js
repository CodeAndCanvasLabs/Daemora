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

const rawConfig = {
  // Server
  port: parseInt(process.env.PORT || "8081", 10),

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

  // Default model (provider:model format)
  defaultModel: process.env.DEFAULT_MODEL || "openai:gpt-5.1-mini",

  // Sub-agent model — used for all sub-agents when no profile-specific model is set.
  // Falls between profile routing (CODE_MODEL etc.) and DEFAULT_MODEL in priority.
  subAgentModel: process.env.SUB_AGENT_MODEL || null,

  // Agent loop
  maxLoops: 40,
  maxSubAgentDepth: 3,

  // Thinking level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  thinkingLevel: process.env.THINKING_LEVEL || "auto",

  // Message queue mode: "steer" (inject into live loop) | "collect" (batch into follow-up) | "followup" (queue as separate)
  queueMode: process.env.QUEUE_MODE || "steer",
  debounceMs: parseInt(process.env.DEBOUNCE_MS || "1500", 10),

  // Safety
  permissionTier: process.env.PERMISSION_TIER || "standard",

  // Cost limits
  maxCostPerTask: parseFloat(process.env.MAX_COST_PER_TASK || "0.50"),
  maxDailyCost: parseFloat(process.env.MAX_DAILY_COST || "10.00"),

  // Cleanup
  cleanupAfterDays: parseInt(process.env.CLEANUP_AFTER_DAYS || "30", 10), // 0 = never

  // Daemon
  daemonMode: process.env.DAEMON_MODE === "true",
  heartbeatIntervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || "30", 10),

  // A2A Security
  a2a: {
    enabled: process.env.A2A_ENABLED === "true",  // OFF by default
    authToken: process.env.A2A_AUTH_TOKEN || null,  // Bearer token required if set
    allowedAgents: process.env.A2A_ALLOWED_AGENTS
      ? process.env.A2A_ALLOWED_AGENTS.split(",").map((s) => s.trim())
      : [],  // Allowlist of agent URLs. Empty = block all external agents
    permissionTier: process.env.A2A_PERMISSION_TIER || "minimal",  // A2A tasks get minimal permissions by default
    maxCostPerTask: parseFloat(process.env.A2A_MAX_COST || "0.05"),  // Much lower budget for external tasks
    rateLimitPerMinute: parseInt(process.env.A2A_RATE_LIMIT || "5", 10),  // Max 5 tasks/min from A2A
    blockedTools: ["executeCommand", "writeFile", "editFile", "sendEmail", "spawnAgent"],  // Tools blocked for A2A tasks
  },

  // Filesystem sandboxing
  // ALLOWED_PATHS: comma-separated dirs the agent can access. Empty = unrestricted (global mode).
  // BLOCKED_PATHS: always blocked even if inside ALLOWED_PATHS.
  // RESTRICT_COMMANDS: when true, executeCommand also enforces path scoping (blocks commands
  //   whose cwd or referenced absolute paths are outside ALLOWED_PATHS).
  filesystem: {
    allowedPaths: process.env.ALLOWED_PATHS
      ? process.env.ALLOWED_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    blockedPaths: process.env.BLOCKED_PATHS
      ? process.env.BLOCKED_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    restrictCommands: process.env.RESTRICT_COMMANDS === "true",
  },

  // Multi-tenant configuration
  // When enabled, each unique channel+userId gets their own tenant record with per-tenant
  // config: model override, allowed/blocked paths, cost limits, tool allowlist, plan tier.
  // Storage: data/tenants/tenants.json  |  Workspaces: data/tenants/{id}/workspace/
  multiTenant: {
    enabled: process.env.MULTI_TENANT_ENABLED === "true",
    // autoRegister: auto-create a tenant record on first message from any user.
    // Set to false to require manual tenant provisioning via API or CLI.
    autoRegister: process.env.AUTO_REGISTER_TENANTS !== "false",  // true by default
    // isolateFilesystem: lock each tenant to their own workspace directory by default
    // (unless they have a custom allowedPaths configured).
    isolateFilesystem: process.env.TENANT_ISOLATE_FILESYSTEM === "true",
  },

  // Sandbox - OS-level command isolation
  // "process" (default): commands run in the current process, tool-level path guards apply.
  // "docker": commands run inside a Docker container, providing kernel-level isolation.
  //   Requires Docker installed. Container gets no network by default (DOCKER_NETWORK=none).
  sandbox: {
    mode: process.env.SANDBOX_MODE || "process",  // "process" | "docker"
    dockerImage: process.env.DOCKER_IMAGE || "node:22-alpine",
    dockerMemory: process.env.DOCKER_MEMORY || "512m",
    dockerCpus: process.env.DOCKER_CPUS || "0.5",
    dockerNetwork: process.env.DOCKER_NETWORK || "none",
  },

  // Channels
  // Each channel supports two universal options:
  //   allowlist - comma-separated IDs/numbers/usernames in env var (e.g. TELEGRAM_ALLOWLIST="123456789,987654321")
  //               If empty or not set → open to everyone. Set this to lock down your bot.
  //   model     - per-channel model override (e.g. TELEGRAM_MODEL="anthropic:claude-opus-4-6")
  //               If not set → global DEFAULT_MODEL is used.
  channels: {
    // HTTP channel is disabled - unauthenticated, see src/channels/index.js
    http: { enabled: false },

    telegram: {
      enabled: !!process.env.TELEGRAM_BOT_TOKEN,
      token: process.env.TELEGRAM_BOT_TOKEN,
      allowlist: process.env.TELEGRAM_ALLOWLIST
        ? process.env.TELEGRAM_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.TELEGRAM_MODEL || null,
    },

    whatsapp: {
      enabled: !!process.env.TWILIO_ACCOUNT_SID,
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      from: process.env.TWILIO_WHATSAPP_FROM,
      allowlist: process.env.WHATSAPP_ALLOWLIST
        ? process.env.WHATSAPP_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.WHATSAPP_MODEL || null,
    },

    email: {
      // Enabled if EITHER Resend (outbound) OR Gmail/SMTP (full) is configured
      enabled: !!(process.env.RESEND_API_KEY || process.env.EMAIL_USER),
      // Resend (recommended - just an API key for outbound sending)
      resendApiKey: process.env.RESEND_API_KEY || null,
      resendFrom:   process.env.RESEND_FROM   || null,
      // Traditional IMAP/SMTP (needed for inbox polling / inbound)
      imap: {
        host: process.env.EMAIL_IMAP_HOST || "imap.gmail.com",
        port: parseInt(process.env.EMAIL_IMAP_PORT || "993", 10),
      },
      smtp: {
        host: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.EMAIL_SMTP_PORT || "587", 10),
      },
      user: process.env.EMAIL_USER     || null,
      password: process.env.EMAIL_PASSWORD || null,
      allowlist: process.env.EMAIL_ALLOWLIST
        ? process.env.EMAIL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.EMAIL_MODEL || null,
    },

    discord: {
      enabled: !!process.env.DISCORD_BOT_TOKEN,
      token: process.env.DISCORD_BOT_TOKEN,
      allowlist: process.env.DISCORD_ALLOWLIST
        ? process.env.DISCORD_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.DISCORD_MODEL || null,
    },

    slack: {
      enabled: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      allowlist: process.env.SLACK_ALLOWLIST
        ? process.env.SLACK_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.SLACK_MODEL || null,
    },

    line: {
      enabled: !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET),
      accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
      allowlist: process.env.LINE_ALLOWLIST
        ? process.env.LINE_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.LINE_MODEL || null,
    },

    signal: {
      enabled: !!(process.env.SIGNAL_CLI_URL && process.env.SIGNAL_PHONE_NUMBER),
      cliUrl: process.env.SIGNAL_CLI_URL,
      phoneNumber: process.env.SIGNAL_PHONE_NUMBER,
      allowlist: process.env.SIGNAL_ALLOWLIST
        ? process.env.SIGNAL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.SIGNAL_MODEL || null,
    },

    teams: {
      enabled: !!(process.env.TEAMS_APP_ID && process.env.TEAMS_APP_PASSWORD),
      appId: process.env.TEAMS_APP_ID,
      appPassword: process.env.TEAMS_APP_PASSWORD,
      allowlist: process.env.TEAMS_ALLOWLIST
        ? process.env.TEAMS_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.TEAMS_MODEL || null,
    },

    googlechat: {
      enabled: !!process.env.GOOGLE_CHAT_SERVICE_ACCOUNT,
      serviceAccount: process.env.GOOGLE_CHAT_SERVICE_ACCOUNT || null,
      projectNumber: process.env.GOOGLE_CHAT_PROJECT_NUMBER || null,
      allowlist: process.env.GOOGLE_CHAT_ALLOWLIST
        ? process.env.GOOGLE_CHAT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      model: process.env.GOOGLE_CHAT_MODEL || null,
    },
  },
};

// Validate config — fail-closed on bad values
const { ok, data, issues } = validateConfig(rawConfig);
if (!ok) {
  console.error("\n[Config] Invalid configuration:\n");
  for (const { path, message } of issues) {
    console.error(`  - "${path}": ${message}`);
  }
  console.error("");
  process.exit(1);
}

export const config = data;
