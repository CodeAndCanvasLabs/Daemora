/**
 * `daemora setup` — interactive first-run configuration.
 *
 * Collects the minimum needed to bring the agent online:
 *   1. Vault passphrase (creates vault if none exists, else unlocks)
 *   2. AI provider + API key (or Ollama model name)
 *   3. Default model id
 *   4. Server port (non-default only)
 *   5. Optional: install as OS service (daemon mode)
 *
 * All values land in the SecretVault / SettingsStore — never in .env.
 * Safe to re-run: existing values become defaults instead of overwriting
 * blindly.
 */

import * as p from "@clack/prompts";

import { ConfigManager } from "../../config/ConfigManager.js";
import { DaemonManager } from "../../daemon/DaemonManager.js";
import type { SecretKey } from "../../config/schema.js";
import { validateApiKey } from "../../models/validateKey.js";
import { logger } from "../../util/logger.js";
import { printBanner } from "../banner.js";

interface ProviderOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly secret: SecretKey;
  readonly keyPrompt: string;
  readonly keyPattern?: RegExp;
  readonly modelHints: readonly string[];
}

const PROVIDERS: readonly ProviderOption[] = [
  { id: "openai",    label: "OpenAI",     hint: "GPT-5 / GPT-4.1",                 secret: "OPENAI_API_KEY",    keyPrompt: "OpenAI API key (sk-...)",    keyPattern: /^sk-/,     modelHints: ["gpt-5", "gpt-4.1", "gpt-4.1-mini"] },
  { id: "anthropic", label: "Anthropic",  hint: "Claude 4 family",                 secret: "ANTHROPIC_API_KEY", keyPrompt: "Anthropic API key (sk-ant-...)", keyPattern: /^sk-ant-/, modelHints: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  { id: "google",    label: "Google AI",  hint: "Gemini 2.5 / 3.x",                secret: "GOOGLE_AI_API_KEY", keyPrompt: "Google AI API key",             modelHints: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "groq",      label: "Groq",       hint: "Fast Llama / Qwen / Mixtral",     secret: "GROQ_API_KEY",      keyPrompt: "Groq API key (gsk_...)",        keyPattern: /^gsk_/, modelHints: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "deepseek",  label: "DeepSeek",   hint: "V3 / R1 — cheap + strong",        secret: "DEEPSEEK_API_KEY",  keyPrompt: "DeepSeek API key (sk-...)",     modelHints: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "xai",       label: "xAI",        hint: "Grok family",                      secret: "XAI_API_KEY",       keyPrompt: "xAI API key",                   modelHints: ["grok-4", "grok-3"] },
  { id: "mistral",   label: "Mistral",    hint: "EU-hosted, GDPR-friendly",        secret: "MISTRAL_API_KEY",   keyPrompt: "Mistral API key",               modelHints: ["mistral-large-latest", "mistral-small-latest"] },
  { id: "openrouter",label: "OpenRouter", hint: "One key, 200+ models",            secret: "OPENROUTER_API_KEY",keyPrompt: "OpenRouter API key (sk-or-...)",modelHints: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"] },
  { id: "ollama",    label: "Ollama",     hint: "Local models — private, offline", secret: "OPENAI_API_KEY"  /* unused */, keyPrompt: "", modelHints: ["llama3.1", "qwen2.5-coder"] },
];

const TOTAL_STEPS = 7;

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function guard<T>(val: T | symbol): T {
  if (p.isCancel(val)) cancelled();
  return val as T;
}

export async function setupCommand(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("setup requires an interactive terminal. Open the UI at http://localhost:<port> for browser-based setup.");
    process.exit(1);
  }

  // Mute pino logs during the wizard. Without this, ConfigManager.open
  // and downstream modules dump pretty-printed log lines into the middle
  // of the @clack/prompts UI, which looks broken.
  logger.level = "silent";

  printBanner({ tagline: "the agent that lives on your machine" });
  p.intro("First-run setup");

  const cfg = ConfigManager.open();

  // ── Step 1: Vault passphrase ──
  p.log.step(`[1/${TOTAL_STEPS}]  Vault passphrase`);
  const vaultExists = cfg.vault.exists();
  if (vaultExists) {
    p.log.info("An existing vault was detected — unlock it to update settings.");
  } else {
    p.note(
      "Secrets (API keys, OAuth tokens) are encrypted at rest with AES-256-GCM.\nThis passphrase is the only way to decrypt them — keep it safe.",
      "Secret vault",
    );
  }
  const passphrase = guard(await p.password({
    message: vaultExists ? "Vault passphrase" : "Choose a vault passphrase (≥ 8 chars)",
    validate: (v) => (!v || v.length < 8 ? "At least 8 characters required." : undefined),
  }));
  try {
    cfg.vault.unlock(passphrase);
  } catch (e) {
    p.log.error(`Failed to unlock: ${(e as Error).message}`);
    process.exit(1);
  }

  // ── Step 2: AI provider ──
  p.log.step(`[2/${TOTAL_STEPS}]  AI provider`);
  const providerId = guard(await p.select<string>({
    message: "Which provider?",
    options: PROVIDERS.map((pr) => ({ value: pr.id, label: pr.label, hint: pr.hint })),
  }));
  const provider = PROVIDERS.find((pr) => pr.id === providerId)!;

  let model: string;
  if (provider.id === "ollama") {
    p.note(
      [
        "Make sure Ollama is running:  ollama serve",
        "Pull a model first:           ollama pull <name>",
        `Known: ${provider.modelHints.join(", ")}`,
      ].join("\n"),
      "Ollama",
    );
    const name = guard(await p.text({
      message: "Model name",
      initialValue: provider.modelHints[0] ?? "llama3.1",
      placeholder: provider.modelHints.join(" / "),
      validate: (v) => (!v ? "Required" : undefined),
    }));
    model = `ollama:${name}`;
  } else {
    // Loop until the key validates against the provider's API. For
    // providers without a list-models endpoint (Suno, Cartesia, etc.)
    // validateApiKey returns ok+skipped so we accept on first input.
    let key = "";
    let liveModels: { id: string; name: string }[] = [];
    let validated = false;
    let skippedValidation = false;
    let skipReason = "";

    while (!validated) {
      key = guard(await p.password({
        message: provider.keyPrompt,
        validate: (v) => {
          if (!v) return "Required";
          if (provider.keyPattern && !provider.keyPattern.test(v)) return `Expected prefix: ${provider.keyPattern.source}`;
          return undefined;
        },
      }));

      const spinner = p.spinner();
      spinner.start(`Validating ${provider.label} key…`);
      const result = await validateApiKey(provider.id, key);
      spinner.stop();

      if (result.ok) {
        validated = true;
        if ("skipped" in result && result.skipped) {
          skippedValidation = true;
          skipReason = result.reason;
          p.log.info(`Saved (no live validation: ${result.reason})`);
        } else {
          liveModels = result.models.map((m) => ({ id: m.id, name: m.name }));
          p.log.success(`Key valid — ${liveModels.length} model${liveModels.length === 1 ? "" : "s"} available.`);
        }
      } else {
        const reason = result.status ? `${result.status} — ${result.message.slice(0, 120)}` : result.message.slice(0, 160);
        p.log.error(`Key rejected: ${reason}`);
        const retry = guard(await p.confirm({ message: "Try a different key?", initialValue: true }));
        if (!retry) cancelled();
      }
    }

    cfg.vault.set(String(provider.secret), key);

    // Now ask which model to use as the default. Prefer the live list
    // if we have one; fall back to provider.modelHints when the
    // provider doesn't expose a list endpoint.
    let modelOptions: { value: string; label: string; hint?: string }[];
    if (liveModels.length > 0) {
      // Sort: hinted models first (familiar names at top), then alphabetical.
      const hintSet = new Set(provider.modelHints);
      modelOptions = liveModels
        .sort((a, b) => {
          const ah = hintSet.has(a.id) ? 0 : 1;
          const bh = hintSet.has(b.id) ? 0 : 1;
          if (ah !== bh) return ah - bh;
          return a.id.localeCompare(b.id);
        })
        .map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` }));
    } else {
      modelOptions = provider.modelHints.map((m) => ({ value: m, label: m }));
    }
    modelOptions.push({ value: "__custom__", label: "Other (enter manually)" });

    const picked = guard(await p.select<string>({
      message: `${provider.label} model${skippedValidation ? "" : ` (${liveModels.length} live)`}`,
      options: modelOptions,
    }));
    if (picked === "__custom__") {
      const custom = guard(await p.text({
        message: "Model name",
        placeholder: provider.modelHints[0] ?? "",
        validate: (v) => (!v ? "Required" : undefined),
      }));
      model = `${provider.id}:${custom}`;
    } else {
      model = `${provider.id}:${picked}`;
    }
    void skipReason;
  }
  cfg.settings.set("DEFAULT_MODEL", model);
  p.log.success(`Default model: ${model}`);

  // ── Step 3: Server port ──
  p.log.step(`[3/${TOTAL_STEPS}]  Server port`);
  const portRaw = guard(await p.text({
    message: "HTTP port",
    initialValue: String(cfg.env.port),
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n < 65536 ? undefined : "Must be an integer 1–65535.";
    },
  }));
  const port = Number(portRaw);
  if (port !== cfg.env.port) {
    cfg.settings.setGeneric("PORT", port);
    p.log.info(`Set PORT=${port} (takes effect on next start)`);
  }

  // ── Step 4: Daemon install (optional) ──
  p.log.step(`[4/${TOTAL_STEPS}]  Background service`);
  const wantDaemon = guard(await p.confirm({
    message: "Install as an OS service so it auto-starts on login?",
    initialValue: false,
  }));
  if (wantDaemon) {
    const dm = new DaemonManager();
    const embedPass = guard(await p.confirm({
      message: "Embed the vault passphrase in the service so it unlocks automatically on boot?",
      initialValue: false,
    }));
    try {
      const result = dm.install(embedPass ? passphrase : undefined);
      p.log.success(`Service installed: ${result.servicePath}`);
    } catch (e) {
      p.log.warn(`Could not install service: ${(e as Error).message}`);
    }
  }

  // ── Step 5: Filesystem guard ──
  p.log.step(`[5/${TOTAL_STEPS}]  Filesystem guard`);
  p.note(
    [
      "off       — no checks (only for trusted environments)",
      "moderate  — block ~/.ssh, ~/.aws, /etc, etc. Most of disk allowed.",
      "strict    — only $HOME and explicit allow-list paths reachable",
      "sandbox   — only explicit allow-list paths reachable. Use to confine",
      "             the agent to a specific project directory.",
    ].join("\n"),
    "What can the agent touch on disk?",
  );
  const fsMode = guard(await p.select<string>({
    message: "Filesystem guard mode",
    initialValue: "moderate",
    options: [
      { value: "off", label: "off",       hint: "No checks" },
      { value: "moderate", label: "moderate", hint: "Default — sensible denylist" },
      { value: "strict", label: "strict", hint: "$HOME + allow-list only" },
      { value: "sandbox", label: "sandbox", hint: "Only allow-list paths" },
    ],
  }));
  cfg.settings.setGeneric("DAEMORA_FS_GUARD", fsMode);
  let fsAllow: readonly string[] = [];
  if (fsMode === "strict" || fsMode === "sandbox") {
    const raw = guard(await p.text({
      message: "Extra allowed paths (comma-separated, absolute)",
      placeholder: "/Users/me/work,/tmp/scratch",
      initialValue: "",
    }));
    fsAllow = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.settings.setGeneric("DAEMORA_FS_ALLOW", fsAllow);
    if (fsMode === "sandbox" && fsAllow.length === 0) {
      p.log.warn("Sandbox mode with no allow-list paths — the agent won't be able to read or write anywhere outside its data dir.");
    }
  }

  // ── Step 6: Plan Mode ──
  p.log.step(`[6/${TOTAL_STEPS}]  Plan mode`);
  p.note(
    [
      "When ON, the agent asks for explicit approval before every",
      "destructive action (write/edit/exec, send_email, browser navigation,",
      "media generation, etc.) — pauses and waits for your 'yes' or 'no'.",
      "Read-only operations (read_file, web_search, etc.) are unaffected.",
      "",
      "Recommended OFF for fast tasks; ON for cautious / production work.",
    ].join("\n"),
    "Plan Mode",
  );
  const planMode = guard(await p.confirm({
    message: "Enable Plan Mode?",
    initialValue: false,
  }));
  cfg.settings.setGeneric("PLAN_MODE", planMode);

  // ── Step 7: Summary ──
  p.log.step(`[7/${TOTAL_STEPS}]  Done`);
  const summary = [
    `Provider:   ${provider.label}`,
    `Model:      ${model}`,
    `Port:       ${port}`,
    `Data dir:   ${cfg.env.dataDir}`,
    `Daemon:     ${wantDaemon ? "installed" : "not installed"}`,
    `FS guard:   ${fsMode}${fsAllow.length ? ` (allow: ${fsAllow.join(", ")})` : ""}`,
    `Plan mode:  ${planMode ? "on" : "off"}`,
  ].join("\n");
  p.note(summary, "Configuration");

  cfg.close();
  p.outro("Run `daemora start` to launch, or open the UI at http://localhost:" + String(port));
}
