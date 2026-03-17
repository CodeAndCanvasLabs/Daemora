import * as p from "@clack/prompts";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import secretVault from "../safety/SecretVault.js";
import { banner, stepHeader, kv, summaryTable, completeBanner, t, S } from "./theme.js";
import { CHANNEL_DEFS } from "../channels/channelDefs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const TOTAL_STEPS = 11;
const OLLAMA_EMBED_MODEL = "all-minilm";

/**
 * Pull all-minilm embedding model (if Ollama available) and pre-embed all skills.
 * This runs during setup so the agent has instant skill matching from first task.
 */
async function setupSkillEmbeddings(provider, envConfig, spin) {
  const { execSync } = await import("child_process");
  const hasOllama = (() => {
    try { execSync("ollama --version", { stdio: "ignore" }); return true; } catch { return false; }
  })();

  // Pull local embedding model as primary (no API key) or fallback (has API key)
  const hasApiEmbedding = envConfig.OPENAI_API_KEY || envConfig.GOOGLE_AI_API_KEY;

  if (hasOllama) {
    const purpose = hasApiEmbedding ? "offline fallback" : "skill matching";
    spin.message(`Pulling ${OLLAMA_EMBED_MODEL} for ${purpose} (22M params, ~45MB)`);
    try {
      execSync(`ollama pull ${OLLAMA_EMBED_MODEL}`, { stdio: "ignore", timeout: 120_000 });
      p.log.success(`${S.check}  Embedding model ${t.bold(OLLAMA_EMBED_MODEL)} ready (${purpose})`);
    } catch {
      if (!hasApiEmbedding) {
        p.log.warn(`Could not pull ${OLLAMA_EMBED_MODEL}. Skill matching will use built-in TF-IDF.`);
      }
    }
  }

  // Pre-embed all skills (works with any provider: API, Ollama, or TF-IDF)
  spin.message("Pre-embedding skills for instant matching");
  try {
    // Temporarily set env vars so the embedding provider can detect them
    if (envConfig.OPENAI_API_KEY) process.env.OPENAI_API_KEY = envConfig.OPENAI_API_KEY;
    if (envConfig.GOOGLE_AI_API_KEY) process.env.GOOGLE_AI_API_KEY = envConfig.GOOGLE_AI_API_KEY;
    if (provider === "ollama" || hasOllama) process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

    const skillLoader = (await import("../skills/SkillLoader.js")).default;
    skillLoader.load();
    await skillLoader.embedSkills();

    const count = skillLoader.list().length;
    p.log.success(`${S.check}  ${count} skills embedded for instant matching`);
  } catch {
    p.log.info("Skill embedding deferred to first startup.");
  }
}

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
      { value: "openai",    label: "OpenAI",    hint: "GPT-5 / GPT-4.1 \u2014 best all-rounder" },
      { value: "anthropic", label: "Anthropic",  hint: "Claude 4 \u2014 great for coding & reasoning" },
      { value: "google",    label: "Google AI",  hint: "Gemini 3.1 / 2.5 \u2014 fast & capable" },
      { value: "xai",       label: "xAI",        hint: "Grok 4 \u2014 conversational & capable" },
      { value: "deepseek",  label: "DeepSeek",   hint: "DeepSeek V3 / R1 \u2014 excellent coder, cheap" },
      { value: "mistral",   label: "Mistral",    hint: "Mistral Large \u2014 European AI, GDPR-friendly" },
      { value: "groq",      label: "Groq",       hint: "Llama, Qwen, GPT-OSS \u2014 fastest inference, free tier" },
      { value: "openrouter", label: "OpenRouter", hint: "Any model via openrouter.ai \u2014 one key, all providers" },
      { value: "ollama",    label: "Ollama",     hint: "Local models \u2014 free, private, offline" },
    ],
  }));

  // Load model registry dynamically
  const { models: modelRegistry } = await import("../config/models.js");

  // Provider config: API key prompt + env var name
  const providerKeys = {
    openai:    { env: "OPENAI_API_KEY",    prompt: "OpenAI API key (sk-...)" },
    anthropic: { env: "ANTHROPIC_API_KEY", prompt: "Anthropic API key (sk-ant-...)" },
    google:    { env: "GOOGLE_AI_API_KEY", prompt: "Google AI API key" },
    xai:       { env: "XAI_API_KEY",       prompt: "xAI API key" },
    deepseek:  { env: "DEEPSEEK_API_KEY",  prompt: "DeepSeek API key (sk-...)" },
    mistral:   { env: "MISTRAL_API_KEY",   prompt: "Mistral API key" },
    groq:       { env: "GROQ_API_KEY",       prompt: "Groq API key (gsk_...)" },
    openrouter: { env: "OPENROUTER_API_KEY", prompt: "OpenRouter API key (sk-or-...)" },
  };

  if (provider === "ollama") {
    // Ollama: list known local models from registry + free text input
    const ollamaModels = Object.entries(modelRegistry)
      .filter(([, m]) => m.provider === "ollama")
      .map(([, m]) => m.model);
    const ollamaHint = ollamaModels.length ? ollamaModels.join(", ") : "llama3.1, qwen2.5-coder";
    p.note(
      [
        "Make sure Ollama is running:  ollama serve",
        "Pull a model first:           ollama pull <model>",
        `Known models: ${ollamaHint}`,
        "You can use any model available in your Ollama installation.",
      ].join("\n"),
      "Ollama (local models)",
    );
    const model = guard(await p.text({
      message: "Ollama model name",
      initialValue: ollamaModels[0] || "llama3.1",
      placeholder: `e.g. ${ollamaHint}`,
    }));
    envConfig.DEFAULT_MODEL = `ollama:${model}`;
  } else {
    // Cloud provider: ask for API key, then show models from registry
    const keyInfo = providerKeys[provider];
    if (keyInfo) {
      const key = guard(await p.password({ message: keyInfo.prompt, validate: (v) => !v ? "Required" : undefined }));
      envConfig[keyInfo.env] = key;
    }

    // Build model options from registry for this provider
    const providerModels = Object.entries(modelRegistry)
      .filter(([, m]) => m.provider === provider)
      .map(([id, m]) => {
        const ctx = m.contextWindow >= 1_000_000
          ? `${(m.contextWindow / 1_000_000).toFixed(0)}M ctx`
          : `${(m.contextWindow / 1_000).toFixed(0)}K ctx`;
        const caps = (m.capabilities || []).filter(c => c !== "text" && c !== "tools").join(", ");
        const price = m.costPer1kInput > 0 ? `$${m.costPer1kInput}/1k in` : "free";
        const parts = [ctx, m.tier, caps, price].filter(Boolean);
        return { value: id, label: m.model, hint: parts.join(" \u00b7 ") };
      });

    if (providerModels.length > 0) {
      envConfig.DEFAULT_MODEL = guard(await p.select({
        message: `${provider.charAt(0).toUpperCase() + provider.slice(1)} model`,
        options: providerModels,
      }));
    } else {
      // Provider not in registry — free text input
      const model = guard(await p.text({
        message: `${provider} model name (e.g. ${provider}:model-name)`,
        validate: (v) => !v ? "Required" : undefined,
      }));
      envConfig.DEFAULT_MODEL = model.includes(":") ? model : `${provider}:${model}`;
    }
  }

  p.log.success(`Provider: ${t.bold(provider)}  Model: ${t.bold(envConfig.DEFAULT_MODEL)}`);

  // ── Sub-Agent Model (optional) ──
  const wantSubModel = guard(await p.confirm({
    message: "Use a different (cheaper/faster) model for sub-agents?",
    initialValue: true,
  }));

  if (wantSubModel) {
    // Only show models from the selected provider
    const subModelOptions = Object.entries(modelRegistry)
      .filter(([id, m]) => m.provider === provider && id !== envConfig.DEFAULT_MODEL)
      .map(([id, m]) => {
        const ctx = m.contextWindow >= 1_000_000
          ? `${(m.contextWindow / 1_000_000).toFixed(0)}M ctx`
          : `${(m.contextWindow / 1_000).toFixed(0)}K ctx`;
        const price = m.costPer1kInput > 0 ? `$${m.costPer1kInput}/1k in` : "free";
        return { value: id, label: m.model, hint: `${ctx} · ${m.tier} · ${price}` };
      })
      .sort((a, b) => (modelRegistry[a.value]?.costPer1kInput || 0) - (modelRegistry[b.value]?.costPer1kInput || 0));

    if (subModelOptions.length > 0) {
      envConfig.SUB_AGENT_MODEL = guard(await p.select({
        message: "Sub-agent model (used for spawned agents, MCP specialists, team members)",
        options: subModelOptions,
      }));
      p.log.success(`Sub-agent model: ${t.bold(envConfig.SUB_AGENT_MODEL)}`);
    } else {
      p.log.info(`No other ${provider} models available. Sub-agents will use the main model.`);
    }
  }

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

  p.note(
    [
      "Select every channel you want to activate.",
      "Each selected channel will ask for its credentials.",
      "You can add more channels later by editing your .env file.",
      "",
      "Tip: each channel supports an optional allowlist (restrict",
      "     who can message the agent) and a model override.",
      "     Configure those later with:  daemora tenant set",
    ].join("\n"),
    "Channels"
  );

  const channels = guard(await p.multiselect({
    message: "Enable channels  (space = toggle, enter = confirm)",
    options: CHANNEL_DEFS.map(ch => ({
      value: ch.name,
      label: ch.label,
      hint: ch.desc,
    })),
    required: false,
  }));

  // ── Per-channel credential collection (generic loop over CHANNEL_DEFS) ────

  for (const ch of CHANNEL_DEFS) {
    if (!channels.includes(ch.name)) continue;

    // Platform check (e.g. iMessage = macOS only)
    if (ch.platformCheck && process.platform !== ch.platformCheck) {
      p.log.warn(`${ch.label} requires ${ch.platformCheck}. Skipping.`);
      continue;
    }

    // Show setup instructions
    p.note(ch.setup.join("\n"), `${ch.label} Setup`);

    // Prompt for each env var
    for (const prompt of (ch.prompts || [])) {
      const opts = { message: prompt.label };
      if (prompt.initialValue) opts.initialValue = prompt.initialValue;
      if (prompt.placeholder) opts.placeholder = prompt.placeholder;

      const val = guard(prompt.type === "password" ? await p.password(opts) : await p.text(opts));
      if (val) envConfig[prompt.key] = val;
    }

    // Handle subFlows (optional feature toggles like WhatsApp voice)
    if (ch.subFlows) {
      for (const flow of ch.subFlows) {
        const enable = guard(await p.confirm({ message: flow.confirm, initialValue: false }));
        if (enable) {
          for (const prompt of flow.prompts) {
            const opts = { message: prompt.label };
            if (prompt.initialValue) opts.initialValue = prompt.initialValue;
            if (prompt.placeholder) opts.placeholder = prompt.placeholder;
            const val = guard(prompt.type === "password" ? await p.password(opts) : await p.text(opts));
            if (val) envConfig[prompt.key] = val;
          }
        }
      }
    }
  }

  const activeChannels = ["HTTP", ...channels.map((c) => {
    const labels = { googlechat: "GoogleChat", imessage: "iMessage", bluebubbles: "BlueBubbles" };
    return labels[c] || c.charAt(0).toUpperCase() + c.slice(1);
  })];
  p.log.success(`Channels: ${t.bold(activeChannels.join(", "))}`);

  // ━━━ Step 6: Tool API Keys (optional) ━━━
  stepHeader(6, TOTAL_STEPS, "Tool API Keys");

  p.note(
    [
      "Some built-in tools need their own API keys to work.",
      "You can skip this now and add keys later via: daemora config set <KEY> <value>",
      "",
      `  ${S.info}  generateImage / textToSpeech / transcribeAudio → OPENAI_API_KEY`,
      `  ${S.info}  textToSpeech (premium voices) → ELEVENLABS_API_KEY`,
      `  ${S.info}  googlePlaces → GOOGLE_PLACES_API_KEY`,
      `  ${S.info}  calendar (Google) → GOOGLE_CALENDAR_API_KEY`,
      `  ${S.info}  database → DATABASE_URL / MYSQL_URL`,
      `  ${S.info}  notification (ntfy) → NTFY_TOPIC + NTFY_TOKEN`,
      `  ${S.info}  notification (pushover) → PUSHOVER_API_TOKEN + PUSHOVER_USER_KEY`,
      `  ${S.info}  philipsHue → HUE_BRIDGE_IP + HUE_API_KEY`,
    ].join("\n"),
    "Optional Tool Credentials"
  );

  const toolKeys = guard(await p.multiselect({
    message: "Configure tool API keys?  (space = toggle, enter = confirm)",
    required: false,
    options: [
      { value: "openai_tools",  label: "OpenAI (images, TTS, transcription)", hint: "OPENAI_API_KEY — skip if already set as main provider" },
      { value: "elevenlabs",    label: "ElevenLabs TTS",                      hint: "Premium voice synthesis" },
      { value: "google_places", label: "Google Places",                       hint: "Location search & details" },
      { value: "google_cal",    label: "Google Calendar",                     hint: "Calendar read/write" },
      { value: "database",      label: "Database",                            hint: "PostgreSQL / MySQL connection" },
      { value: "ntfy",          label: "Ntfy notifications",                  hint: "Push notifications via ntfy.sh" },
      { value: "pushover",      label: "Pushover notifications",              hint: "Push notifications via Pushover" },
      { value: "hue",           label: "Philips Hue",                         hint: "Smart light control" },
      { value: "sonos",         label: "Sonos speaker",                       hint: "Music / audio control" },
      { value: "none",          label: "Skip for now",                        hint: "Add later via daemora config set" },
    ],
  }));

  if (toolKeys.includes("openai_tools") && !envConfig.OPENAI_API_KEY) {
    const key = guard(await p.password({ message: "OpenAI API key (for images, TTS, transcription)" }));
    if (key) envConfig.OPENAI_API_KEY = key;
  }

  if (toolKeys.includes("elevenlabs")) {
    const key = guard(await p.password({ message: "ElevenLabs API key" }));
    if (key) envConfig.ELEVENLABS_API_KEY = key;
  }

  if (toolKeys.includes("google_places")) {
    const key = guard(await p.password({ message: "Google Places API key" }));
    if (key) envConfig.GOOGLE_PLACES_API_KEY = key;
  }

  if (toolKeys.includes("google_cal")) {
    const key = guard(await p.password({ message: "Google Calendar API key" }));
    if (key) envConfig.GOOGLE_CALENDAR_API_KEY = key;
    const calId = guard(await p.text({ message: "Calendar ID", initialValue: "primary" }));
    if (calId) envConfig.GOOGLE_CALENDAR_ID = calId;
  }

  if (toolKeys.includes("database")) {
    p.note(
      "Format: postgresql://user:pass@host:5432/db  or  mysql://user:pass@host:3306/db",
      "Database URL"
    );
    const dbUrl = guard(await p.text({ message: "Database URL (PostgreSQL or MySQL)" }));
    if (dbUrl) {
      if (dbUrl.startsWith("mysql")) envConfig.MYSQL_URL = dbUrl;
      else envConfig.DATABASE_URL = dbUrl;
    }
  }

  if (toolKeys.includes("ntfy")) {
    envConfig.NTFY_URL   = guard(await p.text({ message: "Ntfy server URL", initialValue: "https://ntfy.sh" }));
    envConfig.NTFY_TOPIC = guard(await p.text({ message: "Ntfy topic name" }));
    const ntfyToken = guard(await p.password({ message: "Ntfy access token (optional)" }));
    if (ntfyToken) envConfig.NTFY_TOKEN = ntfyToken;
  }

  if (toolKeys.includes("pushover")) {
    envConfig.PUSHOVER_API_TOKEN = guard(await p.password({ message: "Pushover API token" }));
    envConfig.PUSHOVER_USER_KEY  = guard(await p.password({ message: "Pushover user key" }));
  }

  if (toolKeys.includes("hue")) {
    p.note(
      [
        "Find bridge IP: check your router or use the Hue app.",
        "Get API key: press the bridge button, then run:",
        '  curl -X POST http://<bridge-ip>/api -d \'{"devicetype":"daemora"}\'',
      ].join("\n"),
      "Philips Hue Setup"
    );
    envConfig.HUE_BRIDGE_IP = guard(await p.text({ message: "Hue Bridge IP" }));
    envConfig.HUE_API_KEY   = guard(await p.password({ message: "Hue API key" }));
  }

  if (toolKeys.includes("sonos")) {
    envConfig.SONOS_SPEAKER_IP = guard(await p.text({ message: "Sonos speaker IP address" }));
  }

  const toolCount = toolKeys.filter(k => k !== "none").length;
  if (toolCount > 0) {
    p.log.success(`${toolCount} tool integration(s) configured`);
  } else {
    p.log.info("No tool keys configured. Add later via: daemora config set <KEY> <value>");
  }

  // ━━━ Step 7: Daemon Mode ━━━
  stepHeader(7, TOTAL_STEPS, "Daemon Mode");

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

  // ━━━ Step 8: Data Cleanup ━━━
  stepHeader(8, TOTAL_STEPS, "Data Cleanup");

  const cleanupDays = guard(await p.select({
    message: "Auto-delete old tasks, logs & sessions after how many days?",
    options: [
      { value: "30",  label: "30 days",  hint: "recommended" },
      { value: "7",   label: "7 days",   hint: "aggressive — saves most space" },
      { value: "90",  label: "90 days",  hint: "keep 3 months of history" },
      { value: "365", label: "1 year",   hint: "long-term retention" },
      { value: "0",   label: "Never",    hint: "keep everything forever" },
    ],
  }));
  envConfig.CLEANUP_AFTER_DAYS = cleanupDays;

  p.log.success(`Cleanup: ${t.bold(cleanupDays === "0" ? "Never" : cleanupDays + " days")}`);

  // ━━━ Step 9: MCP Servers ━━━
  stepHeader(9, TOTAL_STEPS, "MCP Tool Servers");

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

  // ── Preset servers (dynamically built from config/mcp.json) ──────────────
  p.log.info(`Press ${t.bold("space")} to select, ${t.bold("enter")} to confirm`);

  const isPlaceholder = (v) => !v || v.startsWith("YOUR_") || v === "" || v.startsWith("${");
  const allServers = Object.entries(mcpConfig.mcpServers || {})
    .filter(([k]) => !k.startsWith("_comment"))
    .map(([name, cfg]) => {
      const envKeys = cfg.env ? Object.keys(cfg.env) : [];
      const headerKeys = cfg.headers ? Object.keys(cfg.headers) : [];
      const needsCreds = envKeys.some(k => isPlaceholder(cfg.env[k]))
        || headerKeys.some(k => isPlaceholder(cfg.headers[k]));
      const comment = mcpConfig.mcpServers[`_comment_${name}`] || "";
      const desc = comment.replace(/^[^-]*-\s*/, "").trim();
      const hint = desc
        ? `${desc}${needsCreds ? " \u2014 needs credentials" : " \u2014 no key needed"}`
        : needsCreds ? "needs credentials" : "no key needed";
      return { value: name, label: name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " "), hint, needsCreds, envKeys, headerKeys, cfg };
    });

  const mcpChoices = guard(await p.multiselect({
    message: "Enable built-in MCP servers",
    options: allServers.map(({ value, label, hint }) => ({ value, label, hint })),
    required: false,
  }));

  for (const serverName of mcpChoices) {
    const serverInfo = allServers.find(s => s.value === serverName);
    if (!serverInfo || !mcpConfig.mcpServers[serverName]) continue;

    if (serverInfo.needsCreds) {
      // Dynamically prompt for each env/header credential
      const credKeys = serverInfo.envKeys.filter(k => isPlaceholder(serverInfo.cfg.env?.[k]));
      const headerCredKeys = serverInfo.headerKeys.filter(k => isPlaceholder(serverInfo.cfg.headers?.[k]));

      if (credKeys.length > 0 || headerCredKeys.length > 0) {
        p.log.info(`${t.bold(serverInfo.label)} requires ${credKeys.length + headerCredKeys.length} credential(s)`);
      }

      let allFilled = true;
      for (const key of credKeys) {
        const val = guard(await p.password({ message: `${key} for ${serverInfo.label}` }));
        if (val) {
          mcpConfig.mcpServers[serverName].env[key] = val;
        } else {
          allFilled = false;
        }
      }
      for (const key of headerCredKeys) {
        const val = guard(await p.password({ message: `${key} for ${serverInfo.label}` }));
        if (val) {
          mcpConfig.mcpServers[serverName].headers[key] = val;
        } else {
          allFilled = false;
        }
      }

      if (allFilled) {
        mcpConfig.mcpServers[serverName].enabled = true;
      } else {
        p.log.warn(`${serverInfo.label}: missing credentials — saved but not enabled`);
      }
    } else {
      mcpConfig.mcpServers[serverName].enabled = true;
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

  // ━━━ Step 10: Secret Vault ━━━
  stepHeader(10, TOTAL_STEPS, "Secret Vault");

  p.note(
    [
      "Encrypt all API keys at rest with AES-256-GCM.",
      "Keys are derived from your passphrase via scrypt.",
      "Even if your machine is compromised, secrets stay safe.",
      "",
      `  ${S.shield}  Per-secret unique IV`,
      `  ${S.shield}  No plaintext keys on disk`,
      `  ${S.shield}  Secrets stored in SQLite (encrypted)`,
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

    // If vault already exists, clear it for fresh setup
    const vaultExists = secretVault.exists();
    if (vaultExists) {
      const { run: dbRun } = await import("../storage/Database.js");
      try { dbRun("DELETE FROM vault_entries"); } catch {}
    }

    vaultPassphrase = guard(await p.password({
      message: "Choose a master passphrase for the encrypted vault (min 8 characters)",
      validate: (v) => {
        if (!v || v.length < 8) return "Passphrase must be at least 8 characters";
      },
    }));

    const spin = p.spinner();
    spin.start("Encrypting secrets");

    try {
      secretVault.unlock(vaultPassphrase);

      const secretKeys = [
        // AI providers
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY",
        "XAI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY",
        // Channel tokens
        "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN",
        "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
        "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET",
        "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
        // Email
        "EMAIL_PASSWORD", "RESEND_API_KEY",
        // Tool API keys
        "ELEVENLABS_API_KEY", "GOOGLE_PLACES_API_KEY", "GOOGLE_CALENDAR_API_KEY",
        "DATABASE_URL", "MYSQL_URL",
        "NTFY_TOKEN", "PUSHOVER_API_TOKEN", "PUSHOVER_USER_KEY",
        "HUE_API_KEY",
        // Tenant encryption key
        "DAEMORA_TENANT_KEY",
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

  // ━━━ Step 10: Multi-Tenant Mode ━━━
  stepHeader(11, TOTAL_STEPS, "Multi-Tenant Mode");

  let multiTenantMode = "personal";

  p.note(
    `  ${S.info}  Personal  — single user, global config (default)\n` +
    `  ${S.info}  Multi-Tenant — per-user isolation, cost limits, model overrides`,
    "Deployment mode"
  );

  const mtChoice = guard(await p.select({
    message: "How will you use Daemora?",
    options: [
      { value: "personal",    label: "Personal",     hint: "Single user, no tenant isolation" },
      { value: "multitenant", label: "Multi-Tenant",  hint: "Multiple users via channels, per-user config" },
    ],
  }));

  if (mtChoice === "multitenant") {
    multiTenantMode = "multitenant";
    envConfig.MULTI_TENANT_ENABLED = "true";
    envConfig.AUTO_REGISTER_TENANTS = "false";
    envConfig.TENANT_ISOLATE_FILESYSTEM = "true";
    const { randomBytes: rb } = await import("crypto");
    envConfig.DAEMORA_TENANT_KEY = rb(16).toString("hex");
    p.log.success(`${S.check}  Multi-tenant enabled — admin-managed tenants, filesystem isolation, encryption key generated`);
  }

  // ━━━ Write Config ━━━
  const spin = p.spinner();
  spin.start("Writing configuration");

  // Write all non-secret config to SQLite config_entries table.
  // Secrets were already vaulted above and removed from envConfig.
  const { configStore } = await import("../config/ConfigStore.js");
  const configCount = configStore.import(envConfig);
  configStore.set("SETUP_COMPLETED", new Date().toISOString());

  // Write a minimal .env — only bootstrap info needed before SQLite is open.
  // Everything else is in SQLite now.
  const envPath = join(ROOT_DIR, ".env");
  const bootstrapLines = [
    "# Daemora Bootstrap",
    `# Generated on ${new Date().toISOString()}`,
    "# All configuration is stored in SQLite (data/daemora.db).",
    "# Only DATA_DIR is needed here if you want a non-default data directory.",
    "# DATA_DIR=/custom/path/to/data",
    "",
  ];
  if (vaultPassphrase) {
    bootstrapLines.push("# Secrets are encrypted in SQLite vault_entries table.");
    bootstrapLines.push("");
  }
  writeFileSync(envPath, bootstrapLines.join("\n"), "utf-8");

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

  // Pull embedding model & pre-embed skills
  spin.message("Setting up skill embeddings");
  try {
    await setupSkillEmbeddings(provider, envConfig, spin);
  } catch {
    // Non-fatal — TF-IDF fallback will handle it
  }

  spin.stop(`${S.check}  Configuration saved to SQLite (${configCount} setting${configCount !== 1 ? "s" : ""})`);

  // ━━━ Summary ━━━
  const fsLabel = envConfig.ALLOWED_PATHS
    ? `Scoped → ${envConfig.ALLOWED_PATHS}`
    : "Global (unrestricted)";

  summaryTable("Configuration Summary", [
    ["Provider",    t.bold(provider)],
    ["Model",       t.bold(envConfig.DEFAULT_MODEL)],
    ["Sub-agent",   envConfig.SUB_AGENT_MODEL ? t.bold(envConfig.SUB_AGENT_MODEL) : t.muted("Same as main")],
    ["Port",        t.bold(port)],
    ["Permissions", t.bold(envConfig.PERMISSION_TIER)],
    ["Budget",      `$${maxTask}/task, $${maxDaily}/day`],
    ["Filesystem",  envConfig.ALLOWED_PATHS ? t.accent(fsLabel) : t.muted(fsLabel)],
    ["Channels",    t.bold(activeChannels.join(", "))],
    ["Daemon",      daemonMode ? t.success("Enabled") : t.muted("Disabled")],
    ["MCP Servers", allEnabled.length > 0 ? t.bold(allEnabled.join(", ")) : t.muted("None")],
    ["Vault",       vaultPassphrase ? t.success("Encrypted") : t.warning("Plaintext (.env)")],
    ["Multi-Tenant", multiTenantMode === "multitenant"
      ? (envConfig.TENANT_ISOLATE_FILESYSTEM === "true" ? t.success("Enabled (isolated)") : t.accent("Enabled"))
      : t.muted("Disabled (personal)")],
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
