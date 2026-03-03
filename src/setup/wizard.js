import * as p from "@clack/prompts";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import secretVault from "../safety/SecretVault.js";
import { banner, stepHeader, kv, summaryTable, completeBanner, t, S } from "./theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const TOTAL_STEPS = 8;

function cancelled() {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function guard(val) {
  if (p.isCancel(val)) cancelled();
  return val;
}

export async function runSetupWizard() {
  banner();
  p.intro(t.h("Daemora Setup"));

  const envConfig = {};

  // ━━━ Step 1: AI Provider ━━━
  stepHeader(1, TOTAL_STEPS, "AI Model Provider");

  const provider = guard(await p.select({
    message: "Which AI provider?",
    options: [
      { value: "openai",    label: "OpenAI",    hint: "GPT-4.1 \u2014 best all-rounder" },
      { value: "anthropic", label: "Anthropic",  hint: "Claude \u2014 great for coding & reasoning" },
      { value: "google",    label: "Google AI",  hint: "Gemini \u2014 fast & capable" },
      { value: "ollama",    label: "Ollama",     hint: "Local models \u2014 free, private" },
    ],
  }));

  if (provider === "openai") {
    const key = guard(await p.password({ message: "OpenAI API key", validate: (v) => !v ? "Required" : undefined }));
    envConfig.OPENAI_API_KEY = key;
    envConfig.DEFAULT_MODEL = guard(await p.select({
      message: "OpenAI model",
      options: [
        { value: "openai:gpt-4.1-mini", label: "gpt-4.1-mini", hint: "Fast & cheap (recommended)" },
        { value: "openai:gpt-4.1",      label: "gpt-4.1",      hint: "Most capable" },
        { value: "openai:gpt-4o-mini",   label: "gpt-4o-mini",  hint: "Balanced" },
      ],
    }));
  } else if (provider === "anthropic") {
    const key = guard(await p.password({ message: "Anthropic API key", validate: (v) => !v ? "Required" : undefined }));
    envConfig.ANTHROPIC_API_KEY = key;
    envConfig.DEFAULT_MODEL = guard(await p.select({
      message: "Claude model",
      options: [
        { value: "anthropic:claude-sonnet-4-6",            label: "claude-sonnet-4-6",  hint: "Fast & smart (recommended)" },
        { value: "anthropic:claude-opus-4-6",              label: "claude-opus-4-6",    hint: "Most capable" },
        { value: "anthropic:claude-haiku-4-5-20251001",    label: "claude-haiku-4-5",   hint: "Fastest & cheapest" },
      ],
    }));
  } else if (provider === "google") {
    const key = guard(await p.password({ message: "Google AI API key", validate: (v) => !v ? "Required" : undefined }));
    envConfig.GOOGLE_AI_API_KEY = key;
    envConfig.DEFAULT_MODEL = "google:gemini-2.0-flash";
  } else if (provider === "ollama") {
    p.note("Make sure Ollama is running: ollama serve", "Ollama");
    const model = guard(await p.text({ message: "Ollama model name", initialValue: "llama3" }));
    envConfig.DEFAULT_MODEL = `ollama:${model}`;
  }

  p.log.success(`Provider: ${t.bold(provider)}  Model: ${t.bold(envConfig.DEFAULT_MODEL)}`);

  // ━━━ Step 2: Server ━━━
  stepHeader(2, TOTAL_STEPS, "Server Configuration");

  const port = guard(await p.text({
    message: "Server port",
    initialValue: "8081",
    validate: (v) => isNaN(v) ? "Must be a number" : undefined,
  }));
  envConfig.PORT = port;

  p.log.success(`Port: ${t.bold(port)}`);

  // ━━━ Step 3: Safety ━━━
  stepHeader(3, TOTAL_STEPS, "Safety & Permissions");

  envConfig.PERMISSION_TIER = guard(await p.select({
    message: "Permission level",
    options: [
      { value: "standard", label: "Standard",  hint: "Read + write + sandboxed commands (recommended)" },
      { value: "minimal",  label: "Minimal",   hint: "Read-only, safest" },
      { value: "full",     label: "Full",       hint: "Everything including email & agents" },
    ],
  }));

  const maxTask = guard(await p.text({ message: "Max cost per task ($)", initialValue: "0.50" }));
  const maxDaily = guard(await p.text({ message: "Max daily cost ($)", initialValue: "10.00" }));
  envConfig.MAX_COST_PER_TASK = maxTask;
  envConfig.MAX_DAILY_COST = maxDaily;

  p.log.success(`Tier: ${t.bold(envConfig.PERMISSION_TIER)}  Budget: $${maxTask}/task, $${maxDaily}/day`);

  // ━━━ Step 4: Filesystem Scoping ━━━
  stepHeader(4, TOTAL_STEPS, "Filesystem Scoping");

  p.note(
    [
      "Control which directories the agent can read/write.",
      "Works like Docker volume mounts - the agent cannot escape",
      "the directories you allow.",
      "",
      `  ${S.arrow}  ${t.accent("Global")}  - agent accesses any file the OS allows (default)`,
      `  ${S.arrow}  ${t.accent("Scoped")}  - agent locked to specific directories only`,
      "",
      "Sensitive system files (.ssh, .env, /etc/shadow, etc.)",
      "are always blocked regardless of this setting.",
    ].join("\n"),
    "Filesystem Scoping"
  );

  const fsMode = guard(await p.select({
    message: "Filesystem access mode",
    options: [
      { value: "global", label: "Global",  hint: "No directory restrictions (default)" },
      { value: "scoped", label: "Scoped",  hint: "Lock agent to specific directories (recommended for shared machines)" },
    ],
  }));

  if (fsMode === "scoped") {
    p.log.info(`Enter the directories the agent is allowed to access.`);
    p.log.info(`${t.muted("Use absolute paths. Example: /Users/you/Downloads")}`);

    const allowedRaw = guard(await p.text({
      message: "Allowed directories (comma-separated)",
      placeholder: "/Users/you/Downloads, /Users/you/Projects",
      validate: (v) => {
        if (!v?.trim()) return "Enter at least one directory";
        const paths = v.split(",").map(s => s.trim()).filter(Boolean);
        for (const p of paths) {
          if (!p.startsWith("/") && !p.match(/^[A-Za-z]:\\/)) {
            return `"${p}" must be an absolute path (start with / or C:\\)`;
          }
        }
      },
    }));
    envConfig.ALLOWED_PATHS = allowedRaw.split(",").map(s => s.trim()).filter(Boolean).join(",");

    const wantBlocked = guard(await p.confirm({
      message: "Block any specific directories within the allowed paths?",
      initialValue: false,
    }));
    if (wantBlocked) {
      const blockedRaw = guard(await p.text({
        message: "Blocked directories (comma-separated)",
        placeholder: "/Users/you/Downloads/private",
      }));
      if (blockedRaw?.trim()) {
        envConfig.BLOCKED_PATHS = blockedRaw.split(",").map(s => s.trim()).filter(Boolean).join(",");
      }
    }

    const restrictCmds = guard(await p.confirm({
      message: "Also restrict shell commands to allowed paths? (RESTRICT_COMMANDS)",
      initialValue: false,
    }));
    envConfig.RESTRICT_COMMANDS = restrictCmds ? "true" : "false";

    const scopeLines = [`Allowed: ${t.bold(envConfig.ALLOWED_PATHS)}`];
    if (envConfig.BLOCKED_PATHS) scopeLines.push(`Blocked: ${t.bold(envConfig.BLOCKED_PATHS)}`);
    scopeLines.push(`Restrict commands: ${t.bold(envConfig.RESTRICT_COMMANDS)}`);
    p.log.success(scopeLines.join("  "));
  } else {
    p.log.success(`Filesystem: ${t.bold("Global")}  (no directory restrictions)`);
  }

  // ━━━ Step 5: Channels ━━━
  stepHeader(5, TOTAL_STEPS, "Communication Channels");

  p.log.info(`HTTP API is always enabled on port ${t.bold(port)}`);
  p.log.info(`Press ${t.bold("space")} to select, ${t.bold("enter")} to confirm`);

  const channels = guard(await p.multiselect({
    message: "Enable additional channels",
    options: [
      { value: "telegram",  label: "Telegram",  hint: "Bot via @BotFather" },
      { value: "whatsapp",  label: "WhatsApp",   hint: "Via Twilio" },
      { value: "email",     label: "Email",       hint: "IMAP + SMTP" },
    ],
    required: false,
  }));

  if (channels.includes("telegram")) {
    p.note(
      [
        "1. Open Telegram, search for @BotFather",
        "2. Send /newbot and follow the prompts",
        "3. Copy the bot token it gives you",
      ].join("\n"),
      "Get Telegram Token"
    );
    const token = guard(await p.password({ message: "Telegram bot token" }));
    if (token) envConfig.TELEGRAM_BOT_TOKEN = token;
  }

  if (channels.includes("whatsapp")) {
    p.note(
      [
        "1. Go to https://console.twilio.com",
        "2. Copy Account SID and Auth Token from dashboard",
        "3. Go to Messaging > Try it out > WhatsApp",
        "4. Follow sandbox setup instructions",
      ].join("\n"),
      "Get Twilio Credentials"
    );
    envConfig.TWILIO_ACCOUNT_SID = guard(await p.password({ message: "Twilio Account SID" }));
    envConfig.TWILIO_AUTH_TOKEN = guard(await p.password({ message: "Twilio Auth Token" }));
    envConfig.TWILIO_WHATSAPP_FROM = guard(await p.text({
      message: "Twilio WhatsApp From number",
      initialValue: "whatsapp:+14155238886",
    }));
  }

  if (channels.includes("email")) {
    p.note(
      [
        "For Gmail:",
        "1. Enable 2-Factor Authentication on your Google account",
        "2. Go to https://myaccount.google.com/apppasswords",
        "3. Create an app password for \"Mail\"",
        "4. Use that 16-char password below (not your Gmail password)",
      ].join("\n"),
      "Email Setup"
    );
    envConfig.EMAIL_USER = guard(await p.text({ message: "Email address" }));
    envConfig.EMAIL_PASSWORD = guard(await p.password({ message: "Email app password" }));
    envConfig.EMAIL_IMAP_HOST = guard(await p.text({ message: "IMAP host", initialValue: "imap.gmail.com" }));
    envConfig.EMAIL_SMTP_HOST = guard(await p.text({ message: "SMTP host", initialValue: "smtp.gmail.com" }));
  }

  const activeChannels = ["HTTP", ...channels.map((c) => c.charAt(0).toUpperCase() + c.slice(1))];
  p.log.success(`Channels: ${t.bold(activeChannels.join(", "))}`);

  // ━━━ Step 6: Daemon ━━━
  stepHeader(6, TOTAL_STEPS, "Daemon Mode");

  p.note(
    [
      "Daemon mode runs Daemora as a native OS service.",
      "It auto-starts on boot and stays running 24/7.",
      "You can stop/start it anytime via CLI.",
      "",
      `  ${S.arrow}  macOS: LaunchAgent (launchctl)`,
      `  ${S.arrow}  Linux: systemd user service`,
      `  ${S.arrow}  Windows: Scheduled Task`,
    ].join("\n"),
    "About Daemon Mode"
  );

  const daemonMode = guard(await p.confirm({ message: "Enable daemon mode (24/7 background service)?" }));
  envConfig.DAEMON_MODE = daemonMode ? "true" : "false";

  if (daemonMode) {
    const heartbeat = guard(await p.text({
      message: "Heartbeat check interval (minutes)",
      initialValue: "30",
    }));
    envConfig.HEARTBEAT_INTERVAL_MINUTES = heartbeat;
  }

  p.log.success(`Daemon: ${t.bold(daemonMode ? "Enabled" : "Disabled")}`);

  // ━━━ Step 7: MCP Servers ━━━
  stepHeader(7, TOTAL_STEPS, "MCP Tool Servers");

  p.note(
    [
      "MCP servers extend your agent with external tools.",
      "Built-in presets run via npx \u2014 no global install needed.",
      "Custom servers can be local stdio processes, HTTP, or SSE.",
      "You can manage servers later with: daemora mcp <action>",
    ].join("\n"),
    "Model Context Protocol"
  );

  const mcpConfigPath = join(ROOT_DIR, "config", "mcp.json");
  let mcpConfig;
  try {
    mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
  } catch {
    mcpConfig = { mcpServers: {} };
  }

  // ── Preset servers ────────────────────────────────────────────────────────
  p.log.info(`Press ${t.bold("space")} to select, ${t.bold("enter")} to confirm`);

  const mcpChoices = guard(await p.multiselect({
    message: "Enable built-in MCP servers",
    options: [
      { value: "github",       label: "GitHub",         hint: "Repos, PRs, issues \u2014 needs token" },
      { value: "brave-search", label: "Brave Search",   hint: "Web search \u2014 needs API key" },
      { value: "memory",       label: "Memory",         hint: "Knowledge graph \u2014 no key needed" },
      { value: "filesystem",   label: "Filesystem",     hint: "File access \u2014 no key needed" },
      { value: "fetch",        label: "Web Fetch",      hint: "Page to text \u2014 no key needed" },
      { value: "git",          label: "Git",            hint: "Repo operations \u2014 no key needed" },
      { value: "slack",        label: "Slack",          hint: "Workspace \u2014 needs bot token" },
      { value: "sentry",       label: "Sentry",         hint: "Error tracking \u2014 needs auth token" },
    ],
    required: false,
  }));

  for (const server of mcpChoices) {
    if (!mcpConfig.mcpServers[server]) continue;

    if (server === "github") {
      p.note(
        [
          "1. Go to https://github.com/settings/tokens",
          "2. Click \"Generate new token (classic)\"",
          "3. Select scopes: repo, read:org, read:user",
          "4. Copy the token (starts with ghp_)",
        ].join("\n"),
        "Get GitHub Token"
      );
      const ghToken = guard(await p.password({ message: "GitHub Personal Access Token" }));
      if (ghToken) {
        mcpConfig.mcpServers.github.enabled = true;
        mcpConfig.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN = ghToken;
      }
    } else if (server === "brave-search") {
      p.note(
        [
          "1. Go to https://api.search.brave.com/register",
          "2. Sign up and get your API key",
          "3. Free tier: 2,000 queries/month",
        ].join("\n"),
        "Get Brave Search Key"
      );
      const braveKey = guard(await p.password({ message: "Brave Search API key" }));
      if (braveKey) {
        mcpConfig.mcpServers["brave-search"].enabled = true;
        mcpConfig.mcpServers["brave-search"].env.BRAVE_API_KEY = braveKey;
      }
    } else if (server === "slack") {
      p.note(
        [
          "1. Go to https://api.slack.com/apps",
          "2. Create a new app > From scratch",
          "3. Add Bot Token Scopes: channels:read, chat:write",
          "4. Install to workspace, copy Bot User OAuth Token (xoxb-...)",
          "5. Get Team ID from workspace URL or Slack settings",
        ].join("\n"),
        "Get Slack Token"
      );
      const slackToken = guard(await p.password({ message: "Slack Bot Token (xoxb-...)" }));
      const slackTeam = guard(await p.text({ message: "Slack Team ID" }));
      if (slackToken && mcpConfig.mcpServers.slack) {
        mcpConfig.mcpServers.slack.enabled = true;
        mcpConfig.mcpServers.slack.env.SLACK_BOT_TOKEN = slackToken;
        mcpConfig.mcpServers.slack.env.SLACK_TEAM_ID = slackTeam;
      }
    } else if (server === "sentry") {
      p.note(
        [
          "1. Go to https://sentry.io/settings/auth-tokens/",
          "2. Create a new auth token",
          "3. Select scopes: project:read, event:read",
        ].join("\n"),
        "Get Sentry Token"
      );
      const sentryToken = guard(await p.password({ message: "Sentry Auth Token" }));
      if (sentryToken && mcpConfig.mcpServers.sentry) {
        mcpConfig.mcpServers.sentry.enabled = true;
        mcpConfig.mcpServers.sentry.env.SENTRY_AUTH_TOKEN = sentryToken;
      }
    } else {
      mcpConfig.mcpServers[server].enabled = true;
    }
  }

  // ── Custom MCP servers ────────────────────────────────────────────────────
  const customServerNames = [];

  let addMore = guard(await p.confirm({
    message: "Add a custom MCP server? (your own server, local tool, or remote endpoint)",
    initialValue: false,
  }));

  while (addMore) {
    p.log.info(`${t.bold("Custom MCP Server")} - 3 transport types supported:`);
    p.log.info(`  ${S.arrow}  ${t.accent("stdio")}  - local subprocess (npx, node, python, go, etc.)`);
    p.log.info(`  ${S.arrow}  ${t.accent("http")}   - remote HTTP server (streamable MCP)`);
    p.log.info(`  ${S.arrow}  ${t.accent("sse")}    - remote SSE server (Server-Sent Events)`);

    const customName = guard(await p.text({
      message: "Server name (no spaces, e.g. mytools, notion, postgres)",
      validate: (v) => {
        if (!v) return "Name is required";
        if (/\s/.test(v)) return "Name cannot contain spaces";
        if (mcpConfig.mcpServers[v]) return `"${v}" already exists - choose a different name`;
      },
    }));

    const customDescription = guard(await p.text({
      message: "Description (what does this server do? helps the agent know when to use it)",
      placeholder: "e.g. Query and manage PostgreSQL database",
      initialValue: "",
    }));

    const transport = guard(await p.select({
      message: "Transport type",
      options: [
        { value: "stdio", label: "stdio",  hint: "Local subprocess - npx, node, python, go binary, etc." },
        { value: "http",  label: "http",   hint: "Remote HTTP endpoint (streamable MCP protocol)" },
        { value: "sse",   label: "sse",    hint: "Remote SSE endpoint (Server-Sent Events)" },
      ],
    }));

    let serverCfg = { enabled: true };

    if (transport === "stdio") {
      p.note(
        [
          "Examples:",
          "  npx:     command=npx   args=-y @scope/server-name",
          "  node:    command=node  args=./path/to/server.js",
          "  python:  command=python3  args=-m my_mcp_server",
          "  binary:  command=./my-mcp-server  args=(leave blank)",
        ].join("\n"),
        "stdio Examples"
      );

      const cmd = guard(await p.text({
        message: "Command (e.g. npx, node, python3, or path to binary)",
        validate: (v) => !v ? "Command is required" : undefined,
      }));

      const argsRaw = guard(await p.text({
        message: "Arguments (space-separated, or leave blank)",
        initialValue: "",
      }));

      serverCfg.command = cmd;
      serverCfg.args = argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [];

      // stdio auth: env vars are injected into the subprocess environment
      const needsEnv = guard(await p.confirm({
        message: "Does this server need environment variables (API keys, tokens)?",
        initialValue: false,
      }));

      if (needsEnv) {
        serverCfg.env = {};
        p.log.info(`  Tip: use \${MY_VAR} to reference existing env vars without pasting secrets`);
        let addMore2 = true;
        while (addMore2) {
          const envKey = guard(await p.text({
            message: "Env var name (e.g. GITHUB_TOKEN)",
            validate: (v) => !v ? "Required" : (!/^[A-Z0-9_]+$/i.test(v) ? "Letters, numbers, underscores only" : undefined),
          }));
          const envVal = guard(await p.password({
            message: `Value for ${t.bold(envKey)}  (or type \${VAR_NAME} to reference an existing env var)`,
            validate: (v) => !v ? "Required" : undefined,
          }));
          serverCfg.env[envKey] = envVal;
          p.log.success(`  ${envKey} set`);
          addMore2 = guard(await p.confirm({ message: "Add another env var?", initialValue: false }));
        }
      }

    } else {
      // HTTP or SSE
      const url = guard(await p.text({
        message: transport === "sse"
          ? "SSE endpoint URL (e.g. https://api.example.com/sse)"
          : "HTTP endpoint URL (e.g. https://api.example.com/mcp)",
        validate: (v) => {
          if (!v) return "URL is required";
          if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http:// or https://";
        },
      }));

      serverCfg.url = url;
      if (transport === "sse") serverCfg.transport = "sse";

      // HTTP/SSE auth: credentials go as HTTP request HEADERS (Authorization, X-API-Key, etc.)
      // They are NOT env vars - they are sent with every HTTP request to the server.
      p.note(
        [
          "HTTP/SSE servers authenticate via request headers, not env vars.",
          "",
          "Common patterns:",
          "  Bearer token  →  Authorization: Bearer <token>",
          "  API key       →  X-API-Key: <key>",
          "  Custom        →  Any-Header-Name: <value>",
          "",
          "Tip: use ${MY_SECRET} to reference env vars without storing secrets here.",
          "     e.g. Authorization: Bearer ${MY_API_TOKEN}",
        ].join("\n"),
        "HTTP/SSE Authentication"
      );

      const authType = guard(await p.select({
        message: "Authentication type",
        options: [
          { value: "none",   label: "None",             hint: "No auth - public or local server" },
          { value: "bearer", label: "Bearer token",     hint: "Authorization: Bearer <token>" },
          { value: "apikey", label: "API key header",   hint: "X-API-Key or custom header name" },
          { value: "custom", label: "Custom headers",   hint: "Add any headers manually" },
        ],
      }));

      if (authType !== "none") {
        serverCfg.headers = {};

        if (authType === "bearer") {
          const token = guard(await p.password({
            message: "Bearer token  (or ${MY_ENV_VAR} to reference an env var)",
            validate: (v) => !v ? "Required" : undefined,
          }));
          // Store the raw value - ${VAR} gets expanded at connect time by MCPClient
          serverCfg.headers["Authorization"] = `Bearer ${token}`;

        } else if (authType === "apikey") {
          const headerName = guard(await p.text({
            message: "Header name",
            initialValue: "X-API-Key",
            validate: (v) => !v ? "Required" : undefined,
          }));
          const apiKey = guard(await p.password({
            message: `Value for ${t.bold(headerName)}  (or \${MY_ENV_VAR})`,
            validate: (v) => !v ? "Required" : undefined,
          }));
          serverCfg.headers[headerName] = apiKey;

        } else {
          // custom - loop
          let addHeader = true;
          while (addHeader) {
            const headerName = guard(await p.text({
              message: "Header name (e.g. Authorization, X-Tenant-ID)",
              validate: (v) => !v ? "Required" : undefined,
            }));
            const headerVal = guard(await p.password({
              message: `Value for ${t.bold(headerName)}  (or \${MY_ENV_VAR})`,
              validate: (v) => !v ? "Required" : undefined,
            }));
            serverCfg.headers[headerName] = headerVal;
            p.log.success(`  ${headerName} set`);
            addHeader = guard(await p.confirm({ message: "Add another header?", initialValue: false }));
          }
        }
      }
    }

    // Save to config
    if (customDescription?.trim()) serverCfg.description = customDescription.trim();
    mcpConfig.mcpServers[customName] = serverCfg;
    customServerNames.push(customName);

    const typeLabel = transport === "stdio"
      ? `${serverCfg.command} ${(serverCfg.args || []).join(" ")}`.trim()
      : serverCfg.url;
    const credCount = transport === "stdio"
      ? Object.keys(serverCfg.env || {}).length
      : Object.keys(serverCfg.headers || {}).length;
    const credLabel = transport === "stdio" ? "env var" : "header";
    p.log.success(
      `Server "${t.bold(customName)}" added  ${t.muted(`(${transport})  ${typeLabel}`)}` +
      (credCount ? `  ${t.muted(`[${credCount} ${credLabel}${credCount > 1 ? "s" : ""}]`)}` : "")
    );

    addMore = guard(await p.confirm({
      message: "Add another custom MCP server?",
      initialValue: false,
    }));
  }

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

  const allEnabled = [...mcpChoices, ...customServerNames];
  if (allEnabled.length > 0) {
    p.log.success(`MCP servers: ${t.bold(allEnabled.join(", "))}`);
  } else {
    p.log.info("No MCP servers configured. Use `daemora mcp add` anytime to add one.");
  }

  // ━━━ Step 8: Secret Vault ━━━
  stepHeader(8, TOTAL_STEPS, "Secret Vault");

  p.note(
    [
      "Encrypt all API keys at rest with AES-256-GCM.",
      "Keys are derived from your passphrase via scrypt.",
      "Even if your machine is compromised, secrets stay safe.",
      "",
      `  ${S.shield}  Per-secret unique IV`,
      `  ${S.shield}  No plaintext keys on disk`,
      `  ${S.shield}  Vault file: data/.vault.enc`,
    ].join("\n"),
    "Encryption"
  );

  const setupVault = guard(await p.confirm({
    message: "Set up encrypted vault for API keys?",
    initialValue: true,
  }));

  let vaultPassphrase = null;

  if (setupVault) {
    mkdirSync(join(ROOT_DIR, "data"), { recursive: true });

    // Check if vault already exists
    const vaultExists = secretVault.exists();

    if (vaultExists) {
      const vaultAction = guard(await p.select({
        message: "An encrypted vault already exists",
        options: [
          { value: "unlock", label: "Unlock existing vault", hint: "Enter your current passphrase" },
          { value: "reset",  label: "Reset vault",           hint: "Delete old vault and create a new one" },
        ],
      }));

      if (vaultAction === "reset") {
        const { unlinkSync } = await import("fs");
        const vaultPath = join(ROOT_DIR, "data", ".vault.enc");
        const saltPath = join(ROOT_DIR, "data", ".vault.salt");
        try { unlinkSync(vaultPath); } catch {}
        try { unlinkSync(saltPath); } catch {}
        p.log.info("Old vault deleted.");
      }
    }

    vaultPassphrase = guard(await p.password({
      message: vaultExists ? "Enter vault passphrase" : "Choose a master passphrase (min 8 characters)",
      validate: (v) => {
        if (!v || v.length < 8) return "Passphrase must be at least 8 characters";
      },
    }));

    const spin = p.spinner();
    spin.start("Encrypting secrets");

    try {
      secretVault.unlock(vaultPassphrase);

      const secretKeys = [
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY",
        "TELEGRAM_BOT_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
        "EMAIL_PASSWORD",
      ];
      let vaultedCount = 0;
      for (const key of secretKeys) {
        if (envConfig[key] && envConfig[key].length >= 8) {
          secretVault.set(key, envConfig[key]);
          vaultedCount++;
          delete envConfig[key];
        }
      }

      secretVault.lock();
      spin.stop(`${S.check}  ${vaultedCount} secret(s) encrypted in vault`);
    } catch (error) {
      spin.stop(`${S.cross}  Vault error: ${error.message}`);
      p.log.warn("Secrets will be stored in .env instead.");
      vaultPassphrase = null;
    }
  } else {
    p.log.info("Vault skipped. API keys will be stored in .env (plaintext).");
  }

  // ━━━ Write Config ━━━
  const spin = p.spinner();
  spin.start("Writing configuration");

  const envLines = [
    "# Daemora Configuration",
    `# Generated on ${new Date().toISOString()}`,
    "",
  ];

  const categories = {
    "AI Model": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY", "DEFAULT_MODEL"],
    "Server": ["PORT"],
    "Safety": ["PERMISSION_TIER", "MAX_COST_PER_TASK", "MAX_DAILY_COST"],
    "Filesystem": ["ALLOWED_PATHS", "BLOCKED_PATHS", "RESTRICT_COMMANDS"],
    "Telegram": ["TELEGRAM_BOT_TOKEN"],
    "WhatsApp": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"],
    "Email": ["EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"],
    "Daemon": ["DAEMON_MODE", "HEARTBEAT_INTERVAL_MINUTES"],
  };

  for (const [category, keys] of Object.entries(categories)) {
    const entries = keys.filter((k) => envConfig[k] !== undefined);
    if (entries.length > 0) {
      envLines.push(`# === ${category} ===`);
      for (const key of entries) envLines.push(`${key}=${envConfig[key]}`);
      envLines.push("");
    }
  }

  if (vaultPassphrase) {
    envLines.push("# API keys encrypted in data/.vault.enc");
    envLines.push("");
  }
  envLines.push("# === A2A ===");
  envLines.push("A2A_ENABLED=false");
  envLines.push("");

  const envPath = join(ROOT_DIR, ".env");
  writeFileSync(envPath, envLines.join("\n"), "utf-8");

  // Install daemon if requested
  if (daemonMode) {
    spin.message("Installing daemon service");
    try {
      const { DaemonManager } = await import("../daemon/DaemonManager.js");
      const dm = new DaemonManager();
      dm.install();
    } catch {
      // Non-fatal - user can install later
    }
  }

  spin.stop(`${S.check}  Configuration saved`);

  // ━━━ Summary ━━━
  const fsLabel = envConfig.ALLOWED_PATHS
    ? `Scoped → ${envConfig.ALLOWED_PATHS}`
    : "Global (unrestricted)";

  summaryTable("Configuration Summary", [
    ["Provider",    t.bold(provider)],
    ["Model",       t.bold(envConfig.DEFAULT_MODEL)],
    ["Port",        t.bold(port)],
    ["Permissions", t.bold(envConfig.PERMISSION_TIER)],
    ["Budget",      `$${maxTask}/task, $${maxDaily}/day`],
    ["Filesystem",  envConfig.ALLOWED_PATHS ? t.accent(fsLabel) : t.muted(fsLabel)],
    ["Channels",    t.bold(activeChannels.join(", "))],
    ["Daemon",      daemonMode ? t.success("Enabled") : t.muted("Disabled")],
    ["MCP Servers", allEnabled.length > 0 ? t.bold(allEnabled.join(", ")) : t.muted("None")],
    ["Vault",       vaultPassphrase ? t.success("Encrypted") : t.warning("Plaintext (.env)")],
  ]);

  // ━━━ Next Steps ━━━
  const nextSteps = [
    `${S.arrow}  ${t.bold("Start the agent")}`,
    `   ${t.cmd("daemora start")}`,
    "",
  ];

  if (vaultPassphrase) {
    nextSteps.push(
      `${S.arrow}  ${t.bold("Unlock vault")}`,
      `   ${t.muted("Enter your passphrase when prompted on start")}`,
      "",
    );
  }

  if (daemonMode) {
    nextSteps.push(
      `${S.arrow}  ${t.bold("Daemon controls")}`,
      `   ${t.cmd("daemora daemon status")}`,
      `   ${t.cmd("daemora daemon stop")}`,
      `   ${t.cmd("daemora daemon start")}`,
      "",
    );
  }

  nextSteps.push(
    `${S.arrow}  ${t.bold("Message your bot on the channels you configured")}`,
    "",
    `${S.arrow}  ${t.bold("All commands")}`,
    `   ${t.cmd("daemora help")}`,
  );

  completeBanner(nextSteps);

  p.outro(t.h("Daemora is ready."));
}
