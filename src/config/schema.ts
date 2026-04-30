/**
 * Daemora-TS configuration schema. The single source of truth for what
 * is configurable, what's a secret vs setting, and what's editable.
 *
 * Add a field here ONCE — UI, validation, and config endpoints all
 * derive from this schema. No more "edit four files to add a setting".
 */

import { z } from "zod";

/**
 * Where a value comes from.
 *  - "vault"   : encrypted SQLite store; only for secrets
 *  - "settings": plain SQLite KV; user-editable non-secret preferences
 *  - "env"     : process.env / .env file; deployment-time only
 *  - "default" : the schema default; nothing is set
 */
export type ConfigSource = "vault" | "settings" | "env" | "default";

/**
 * Setting field — non-secret, user-editable, hot-reloadable.
 * Appears in /api/settings UI.
 */
export interface SettingFieldDef<T> {
  readonly kind: "setting";
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly group: SettingGroup;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  /** Read-only fields (deployment env). UI shows but doesn't allow edit. */
  readonly editable: boolean;
}

/**
 * Secret field — encrypted-at-rest, only writable via dedicated vault
 * endpoints. Never echoed back through /api/settings. Lives in vault.
 */
export interface SecretFieldDef {
  readonly kind: "secret";
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly group: SecretGroup;
  /** Optional regex the value must match (e.g. "^sk-"). */
  readonly pattern?: RegExp;
  /**
   * If true, this secret is part of an OAuth integration and the
   * usual API-key-form UI is replaced with a Connect button.
   */
  readonly oauth?: { integration: string; tokenType: "access" | "refresh" | "client_id" | "client_secret" };
}

export type FieldDef<T = unknown> = SettingFieldDef<T> | SecretFieldDef;

export type SettingGroup =
  | "general"
  | "models"
  | "voice"
  | "behaviour"
  | "developer";

export type SecretGroup =
  | "ai_providers"
  | "voice_providers"
  | "search_providers"
  | "channels"
  | "integrations"
  | "system";

// ── Settings (non-secret, hot-reloadable) ────────────────────────────────────

const setting = <T>(d: Omit<SettingFieldDef<T>, "kind" | "editable"> & { editable?: boolean }): SettingFieldDef<T> => ({
  kind: "setting",
  editable: d.editable ?? true,
  ...d,
});

/**
 * Boolean coercion that handles the way the Settings form serializes
 * toggles — usually as the strings `"true"` / `"false"` — while still
 * accepting native booleans from API callers.
 *
 * Why not `z.coerce.boolean()`: that follows JS `Boolean()` semantics,
 * so the string `"false"` becomes `true` (any non-empty string is
 * truthy). That bug silently flipped toggles whenever a user turned
 * one OFF from the UI.
 */
const stringBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const norm = v.trim().toLowerCase();
    if (norm === "true" || norm === "1") return true;
    if (norm === "false" || norm === "0" || norm === "") return false;
  }
  return v;
}, z.boolean()) as unknown as z.ZodType<boolean>;

export const settings = {
  DEFAULT_MODEL: setting<string | null>({
    key: "DEFAULT_MODEL",
    label: "Default Model",
    description: "The model used when a task doesn't specify one. Format: provider:model",
    group: "models",
    schema: z.string().regex(/^[a-z][a-z0-9-]*:.+/, "Format: provider:model").nullable(),
    defaultValue: null,
  }),
  IMAGE_GEN_MODEL: setting<string | null>({
    key: "IMAGE_GEN_MODEL",
    label: "Image Generation Model",
    description: "Model used by the generate_image tool. Format: provider:model.",
    group: "models",
    schema: z.string().regex(/^[a-z][a-z0-9-]*:.+/, "Format: provider:model").nullable(),
    defaultValue: null,
  }),
  VIDEO_GEN_MODEL: setting<string | null>({
    key: "VIDEO_GEN_MODEL",
    label: "Video Generation Model",
    description: "Model used by the generate_video tool. Format: provider:model.",
    group: "models",
    schema: z.string().regex(/^[a-z][a-z0-9-]*:.+/, "Format: provider:model").nullable(),
    defaultValue: null,
  }),
  OLLAMA_BASE_URL: setting<string>({
    key: "OLLAMA_BASE_URL",
    label: "Ollama Base URL",
    description: "Where Ollama is running. Default: http://localhost:11434",
    group: "models",
    schema: z.string().url(),
    defaultValue: "http://localhost:11434",
  }),
  WAKE_WORD_ENABLED: setting<boolean>({
    key: "WAKE_WORD_ENABLED",
    label: "Wake Word",
    description: "Listen for a wake phrase to activate voice mode.",
    group: "voice",
    schema: stringBoolean,
    defaultValue: false,
  }),
  WAKE_WORD: setting<string>({
    key: "WAKE_WORD",
    label: "Wake Phrase",
    description: "The phrase that activates voice mode.",
    group: "voice",
    schema: z.enum(["hey_jarvis", "alexa", "hey_mycroft", "hey_rhasspy"]),
    defaultValue: "hey_jarvis",
  }),
  MAX_COST_PER_TASK: setting<number>({
    key: "MAX_COST_PER_TASK",
    label: "Max cost per task (USD)",
    description: "Hard ceiling for any single task. 0 = no limit.",
    group: "behaviour",
    // Coerce — the Settings form serialises numeric inputs as strings.
    schema: z.coerce.number().nonnegative(),
    defaultValue: 0.5,
  }),
  TASK_TIMEOUT_MS: setting<number>({
    key: "TASK_TIMEOUT_MS",
    label: "Task timeout (ms)",
    description: "Per-task safety timeout. Long-running autonomous tasks (campaigns, daily-rhythm loops) need a high value or 0. Default 0 = no timeout.",
    group: "behaviour",
    schema: z.coerce.number().int().nonnegative(),
    defaultValue: 0,
  }),
  HEARTBEAT_ENABLED: setting<boolean>({
    key: "HEARTBEAT_ENABLED",
    label: "Heartbeat (proactive check)",
    description: "Periodic self-scan that reviews failed tasks, stuck cron, and unfired watchers, then drives an agent turn to fix them. Off if you want a quiet system.",
    group: "behaviour",
    schema: stringBoolean,
    defaultValue: true,
  }),
  HEARTBEAT_INTERVAL_MINUTES: setting<number>({
    key: "HEARTBEAT_INTERVAL_MINUTES",
    label: "Heartbeat interval (minutes)",
    description: "How often the proactive check fires when enabled. Default 240 (4h). 0 also disables.",
    group: "behaviour",
    schema: z.coerce.number().int().nonnegative(),
    defaultValue: 240,
  }),
  LIVEKIT_URL: setting<string>({
    key: "LIVEKIT_URL",
    label: "LiveKit Server URL",
    description: "WebSocket URL for LiveKit. Default ws://127.0.0.1:7880 for local.",
    group: "voice",
    schema: z.string().url(),
    defaultValue: "ws://127.0.0.1:7880",
  }),
  AUTH_ENABLED: setting<boolean>({
    key: "AUTH_ENABLED",
    label: "Require sign-in",
    description: "When on, /api/* endpoints require a signed-in session (passphrase login). Loopback scripts still work via the local auth-token file. Off until the user turns it on from the setup wizard or settings.",
    group: "general",
    schema: stringBoolean,
    defaultValue: false,
  }),
  PUBLIC_URL: setting<string>({
    key: "PUBLIC_URL",
    label: "Public URL",
    description: "Externally reachable URL for this instance. Used to build webhook registration URLs and tunnel fallback. Leave blank to auto-detect or use a tunnel.",
    group: "general",
    schema: z.string(),
    defaultValue: "",
  }),
  MAX_DAILY_COST: setting<number>({
    key: "MAX_DAILY_COST",
    label: "Max daily cost (USD)",
    description: "Total spend ceiling per day across all tasks. 0 = no limit.",
    group: "behaviour",
    // Coerce — the Settings form serialises numeric inputs as strings.
    schema: z.coerce.number().nonnegative(),
    defaultValue: 10,
  }),
} satisfies Record<string, SettingFieldDef<unknown>>;

// ── Secrets (encrypted vault, never in env at runtime) ──────────────────────

const secret = (d: Omit<SecretFieldDef, "kind">): SecretFieldDef => ({ kind: "secret", ...d });

export const secrets = {
  ANTHROPIC_API_KEY: secret({
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    description: "API key for Claude models.",
    group: "ai_providers",
    pattern: /^sk-ant-/,
  }),
  OPENAI_API_KEY: secret({
    key: "OPENAI_API_KEY",
    label: "OpenAI",
    description: "API key for GPT models.",
    group: "ai_providers",
    pattern: /^sk-/,
  }),
  GOOGLE_AI_API_KEY: secret({
    key: "GOOGLE_AI_API_KEY",
    label: "Google AI",
    description: "API key for Gemini models.",
    group: "ai_providers",
  }),
  GOOGLE_VERTEX_API_KEY: secret({
    key: "GOOGLE_VERTEX_API_KEY",
    label: "Vertex AI (Express)",
    description: "Vertex AI Express API key — Gemini on GCP, no project/SA needed.",
    group: "ai_providers",
  }),
  GROQ_API_KEY: secret({
    key: "GROQ_API_KEY",
    label: "Groq",
    description: "API key for fast Llama / Whisper / Orpheus inference.",
    group: "ai_providers",
    pattern: /^gsk_/,
  }),
  NVIDIA_API_KEY: secret({
    key: "NVIDIA_API_KEY",
    label: "NVIDIA",
    description: "API key for NVIDIA NIM — DeepSeek, Llama, Mistral, Qwen, and other open models.",
    group: "ai_providers",
    pattern: /^nvapi-/,
  }),
  DEEPGRAM_API_KEY: secret({
    key: "DEEPGRAM_API_KEY",
    label: "Deepgram",
    description: "Streaming STT via Nova-2.",
    group: "voice_providers",
  }),
  ASSEMBLYAI_API_KEY: secret({
    key: "ASSEMBLYAI_API_KEY",
    label: "AssemblyAI",
    description: "High-accuracy STT via Universal-2.",
    group: "voice_providers",
  }),
  ELEVENLABS_API_KEY: secret({
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs",
    description: "Premium TTS voices.",
    group: "voice_providers",
  }),
  CARTESIA_API_KEY: secret({
    key: "CARTESIA_API_KEY",
    label: "Cartesia",
    description: "Low-latency TTS via Sonic.",
    group: "voice_providers",
  }),
  BRAVE_SEARCH_API_KEY: secret({
    key: "BRAVE_SEARCH_API_KEY",
    label: "Brave Search",
    description: "Web search tool. Free tier: 2k queries/month.",
    group: "integrations",
  }),
  OPENROUTER_API_KEY: secret({
    key: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    description: "Multi-provider gateway — access 200+ models with one key.",
    group: "ai_providers",
  }),
  DEEPSEEK_API_KEY: secret({
    key: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    description: "DeepSeek V3 and R1 models.",
    group: "ai_providers",
  }),
  MISTRAL_API_KEY: secret({
    key: "MISTRAL_API_KEY",
    label: "Mistral AI",
    description: "Mistral Large, Small, and Codestral.",
    group: "ai_providers",
  }),
  XAI_API_KEY: secret({
    key: "XAI_API_KEY",
    label: "xAI",
    description: "Grok models.",
    group: "ai_providers",
  }),
  TOGETHER_API_KEY: secret({
    key: "TOGETHER_API_KEY",
    label: "Together AI",
    description: "Open-source models at scale.",
    group: "ai_providers",
  }),
  FIREWORKS_API_KEY: secret({
    key: "FIREWORKS_API_KEY",
    label: "Fireworks AI",
    description: "Fast open-source model inference.",
    group: "ai_providers",
  }),
  CEREBRAS_API_KEY: secret({
    key: "CEREBRAS_API_KEY",
    label: "Cerebras",
    description: "Ultra-fast inference on Cerebras hardware.",
    group: "ai_providers",
  }),
  PERPLEXITY_API_KEY: secret({
    key: "PERPLEXITY_API_KEY",
    label: "Perplexity",
    description: "Search-augmented AI models (Sonar).",
    group: "ai_providers",
  }),
  LIVEKIT_API_KEY: secret({
    key: "LIVEKIT_API_KEY",
    label: "LiveKit API Key",
    description: "LiveKit server API key. Default 'devkey' for local --dev mode.",
    group: "system",
  }),
  LIVEKIT_API_SECRET: secret({
    key: "LIVEKIT_API_SECRET",
    label: "LiveKit API Secret",
    description: "LiveKit server secret. Default 'secret' for local --dev mode.",
    group: "system",
  }),
  RESEND_API_KEY: secret({
    key: "RESEND_API_KEY",
    label: "Resend",
    description: "Email sending via Resend API.",
    group: "integrations",
  }),
  // Web search providers — referenced by tools/core/webSearch.ts. Without
  // these declared as secrets, the bulk PUT /api/settings would route
  // them to the plaintext settings_entries table instead of the vault.
  FIRECRAWL_API_KEY: secret({
    key: "FIRECRAWL_API_KEY",
    label: "Firecrawl",
    description: "Web search + JS-rendered page scraping. Used by web_search and web_fetch fallback.",
    group: "search_providers",
  }),
  TAVILY_API_KEY: secret({
    key: "TAVILY_API_KEY",
    label: "Tavily",
    description: "AI-augmented web search with synthesized answers.",
    group: "search_providers",
  }),
  BRAVE_API_KEY: secret({
    key: "BRAVE_API_KEY",
    label: "Brave Search (alias)",
    description: "Alternate slot for Brave Search key. Same as BRAVE_SEARCH_API_KEY — either works.",
    group: "search_providers",
  }),
  SUNO_API_KEY: secret({
    key: "SUNO_API_KEY",
    label: "Suno",
    description: "Music generation via Suno API.",
    group: "integrations",
  }),
  DISCORD_BOT_TOKEN: secret({
    key: "DISCORD_BOT_TOKEN",
    label: "Discord Bot Token",
    description: "Bot token for Discord channel integration.",
    group: "channels",
  }),
} satisfies Record<string, SecretFieldDef>;

// ── Env-only (boot-time, read-only at runtime) ───────────────────────────────

export const envOnly = {
  PORT: { key: "PORT", schema: z.coerce.number().int().positive().default(8081) },
  DAEMORA_DATA_DIR: { key: "DAEMORA_DATA_DIR", schema: z.string().optional() },
  DAEMON_MODE: { key: "DAEMON_MODE", schema: z.coerce.boolean().default(false) },
  LOG_LEVEL: { key: "LOG_LEVEL", schema: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info") },
} as const;

// ── Type helpers ─────────────────────────────────────────────────────────────

export type SettingKey = keyof typeof settings;
export type SecretKey = keyof typeof secrets;
export type EnvKey = keyof typeof envOnly;

export type SettingValue<K extends SettingKey> = z.infer<(typeof settings)[K]["schema"]>;

/** All known setting/secret/env field definitions, indexed for lookup. */
export const allFields: ReadonlyMap<string, FieldDef> = new Map([
  ...Object.values(settings).map((d) => [d.key, d as FieldDef] as const),
  ...Object.values(secrets).map((d) => [d.key, d as FieldDef] as const),
]);

export function isSecret(key: string): boolean {
  const f = allFields.get(key);
  return f?.kind === "secret";
}

export function isSetting(key: string): boolean {
  const f = allFields.get(key);
  return f?.kind === "setting";
}
