/**
 * Model registry - metadata for all supported models.
 * Used by ModelRouter for selection, cost tracking, and compaction thresholds.
 *
 * Pricing: costPer1kInput / costPer1kOutput in USD per 1,000 tokens.
 * Source: Official provider pricing pages (as of March 2026).
 */
export const models = {
  // ─── OpenAI ──────────────────────────────────────────────────────────────────

  // GPT-5.4 (1M context)
  "openai:gpt-5.4": {
    provider: "openai", model: "gpt-5.4",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0025, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output", "vision", "computer-use"],
    tier: "standard",
  },
  "openai:gpt-5.4-mini": {
    provider: "openai", model: "gpt-5.4-mini",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0003, costPer1kOutput: 0.0012,
    capabilities: ["text", "tools", "structured-output", "vision", "computer-use"],
    tier: "cheap",
  },
  "openai:gpt-5.4-pro": {
    provider: "openai", model: "gpt-5.4-pro",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.030, costPer1kOutput: 0.180,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning", "computer-use"],
    tier: "expensive",
  },

  // GPT-5.2 (400K context)
  "openai:gpt-5.2": {
    provider: "openai", model: "gpt-5.2",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00175, costPer1kOutput: 0.014,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "openai:gpt-5.2-pro": {
    provider: "openai", model: "gpt-5.2-pro",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.021, costPer1kOutput: 0.168,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "expensive",
  },

  // GPT-5.1
  "openai:gpt-5.1": {
    provider: "openai", model: "gpt-5.1",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },

  // GPT-5 (400K context)
  "openai:gpt-5": {
    provider: "openai", model: "gpt-5",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "openai:gpt-5-pro": {
    provider: "openai", model: "gpt-5-pro",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.015, costPer1kOutput: 0.120,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "expensive",
  },
  "openai:gpt-5-mini": {
    provider: "openai", model: "gpt-5-mini",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.0005, costPer1kOutput: 0.004,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },
  "openai:gpt-5-nano": {
    provider: "openai", model: "gpt-5-nano",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00005, costPer1kOutput: 0.0004,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },

  // GPT-5 Codex
  "openai:gpt-5.3-codex": {
    provider: "openai", model: "gpt-5.3-codex",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00175, costPer1kOutput: 0.014,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "openai:gpt-5.1-codex": {
    provider: "openai", model: "gpt-5.1-codex",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "openai:gpt-5.1-codex-mini": {
    provider: "openai", model: "gpt-5.1-codex-mini",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00025, costPer1kOutput: 0.002,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },
  "openai:gpt-5-codex": {
    provider: "openai", model: "gpt-5-codex",
    contextWindow: 400_000, compactAt: 280_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },

  // GPT-4.1 (1M context)
  "openai:gpt-4.1": {
    provider: "openai", model: "gpt-4.1",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.008,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "openai:gpt-4.1-mini": {
    provider: "openai", model: "gpt-4.1-mini",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0004, costPer1kOutput: 0.0016,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },
  "openai:gpt-4.1-nano": {
    provider: "openai", model: "gpt-4.1-nano",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0001, costPer1kOutput: 0.0004,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // GPT-4o
  "openai:gpt-4o": {
    provider: "openai", model: "gpt-4o",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.0025, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "openai:gpt-4o-mini": {
    provider: "openai", model: "gpt-4o-mini",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.00015, costPer1kOutput: 0.0006,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },

  // o-series reasoning
  "openai:o1": {
    provider: "openai", model: "o1",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.015, costPer1kOutput: 0.060,
    capabilities: ["text", "tools", "reasoning", "vision"],
    tier: "expensive",
  },
  "openai:o1-pro": {
    provider: "openai", model: "o1-pro",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.150, costPer1kOutput: 0.600,
    capabilities: ["text", "tools", "reasoning", "vision"],
    tier: "expensive",
  },
  "openai:o3-pro": {
    provider: "openai", model: "o3-pro",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.020, costPer1kOutput: 0.080,
    capabilities: ["text", "tools", "reasoning", "vision"],
    tier: "expensive",
  },
  "openai:o3": {
    provider: "openai", model: "o3",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.008,
    capabilities: ["text", "tools", "reasoning", "vision"],
    tier: "standard",
  },
  "openai:o4-mini": {
    provider: "openai", model: "o4-mini",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.0011, costPer1kOutput: 0.0044,
    capabilities: ["text", "tools", "reasoning", "vision"],
    tier: "cheap",
  },
  "openai:o3-mini": {
    provider: "openai", model: "o3-mini",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.0011, costPer1kOutput: 0.0044,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },

  // Specialized
  "openai:computer-use-preview": {
    provider: "openai", model: "computer-use-preview",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.012,
    capabilities: ["text", "tools", "computer-use"],
    tier: "standard",
  },

  // ─── Anthropic ───────────────────────────────────────────────────────────────

  "anthropic:claude-opus-4-6": {
    provider: "anthropic", model: "claude-opus-4-6",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.005, costPer1kOutput: 0.025,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "expensive",
  },
  "anthropic:claude-opus-4-5": {
    provider: "anthropic", model: "claude-opus-4-5",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.005, costPer1kOutput: 0.025,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "expensive",
  },
  "anthropic:claude-opus-4-1": {
    provider: "anthropic", model: "claude-opus-4-1",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.015, costPer1kOutput: 0.075,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "expensive",
  },
  "anthropic:claude-opus-4": {
    provider: "anthropic", model: "claude-opus-4",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.015, costPer1kOutput: 0.075,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "expensive",
  },
  "anthropic:claude-sonnet-4-6": {
    provider: "anthropic", model: "claude-sonnet-4-6",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "standard",
  },
  "anthropic:claude-sonnet-4-5": {
    provider: "anthropic", model: "claude-sonnet-4-5",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "standard",
  },
  "anthropic:claude-sonnet-4": {
    provider: "anthropic", model: "claude-sonnet-4",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "anthropic:claude-haiku-4-5": {
    provider: "anthropic", model: "claude-haiku-4-5",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.00025, costPer1kOutput: 0.00125,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "cheap",
  },
  "anthropic:claude-haiku-3-5": {
    provider: "anthropic", model: "claude-haiku-3-5",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.0008, costPer1kOutput: 0.004,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // ─── Google ──────────────────────────────────────────────────────────────────

  "google:gemini-3.1-pro-preview": {
    provider: "google", model: "gemini-3.1-pro-preview",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.012,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "standard",
  },
  "google:gemini-3.1-flash-lite-preview": {
    provider: "google", model: "gemini-3.1-flash-lite-preview",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.00025, costPer1kOutput: 0.0015,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },
  "google:gemini-3-pro-preview": {
    provider: "google", model: "gemini-3-pro-preview",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.012,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "google:gemini-3-flash-preview": {
    provider: "google", model: "gemini-3-flash-preview",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0005, costPer1kOutput: 0.003,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },
  "google:gemini-2.5-pro": {
    provider: "google", model: "gemini-2.5-pro",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "standard",
  },
  "google:gemini-2.5-flash": {
    provider: "google", model: "gemini-2.5-flash",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0003, costPer1kOutput: 0.0025,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "cheap",
  },
  "google:gemini-2.5-flash-lite": {
    provider: "google", model: "gemini-2.5-flash-lite",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0001, costPer1kOutput: 0.0004,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },
  "google:gemini-2.0-flash": {
    provider: "google", model: "gemini-2.0-flash",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.00015, costPer1kOutput: 0.0006,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },
  "google:gemini-2.0-flash-lite": {
    provider: "google", model: "gemini-2.0-flash-lite",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.000075, costPer1kOutput: 0.0003,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // ─── xAI (Grok) ────────────────────────────────────────────────────────────

  // Grok 4.20 series (2M context)
  "xai:grok-4.20-multi-agent-beta-0309": {
    provider: "xai", model: "grok-4.20-multi-agent-beta-0309",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.006,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning", "multi-agent"],
    tier: "standard",
  },
  "xai:grok-4.20-beta-0309-reasoning": {
    provider: "xai", model: "grok-4.20-beta-0309-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.006,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "standard",
  },
  "xai:grok-4.20-beta-0309-non-reasoning": {
    provider: "xai", model: "grok-4.20-beta-0309-non-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.002, costPer1kOutput: 0.006,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },

  // Grok Code (256K context, cheapest)
  "xai:grok-code-fast-1": {
    provider: "xai", model: "grok-code-fast-1",
    contextWindow: 256_000, compactAt: 180_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0015,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // Grok 4 Fast series (2M context, cheapest fast)
  "xai:grok-4-fast-reasoning": {
    provider: "xai", model: "grok-4-fast-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0005,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "cheap",
  },
  "xai:grok-4-fast-non-reasoning": {
    provider: "xai", model: "grok-4-fast-non-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0005,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },

  // Grok 4.1 Fast (2M context)
  "xai:grok-4-1-fast-reasoning": {
    provider: "xai", model: "grok-4-1-fast-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0005,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "cheap",
  },
  "xai:grok-4-1-fast-non-reasoning": {
    provider: "xai", model: "grok-4-1-fast-non-reasoning",
    contextWindow: 2_000_000, compactAt: 1_400_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0005,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "cheap",
  },

  // Grok 4 (256K, premium)
  "xai:grok-4-0709": {
    provider: "xai", model: "grok-4-0709",
    contextWindow: 256_000, compactAt: 180_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output", "vision", "reasoning"],
    tier: "expensive",
  },

  // Grok 3 (131K context)
  "xai:grok-3": {
    provider: "xai", model: "grok-3",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "xai:grok-3-mini": {
    provider: "xai", model: "grok-3-mini",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.0003, costPer1kOutput: 0.0005,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },

  // ─── Groq (hosted models - uses GROQ_API_KEY) ──────────────────────────────

  // groq/compound and groq/compound-mini removed - don't support custom tool calling (only Groq built-in tools)

  // Meta Llama on Groq
  "groq:llama-3.1-8b-instant": {
    provider: "groq", model: "llama-3.1-8b-instant",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.00005, costPer1kOutput: 0.00008,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },
  "groq:llama-3.3-70b-versatile": {
    provider: "groq", model: "llama-3.3-70b-versatile",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.00044, costPer1kOutput: 0.00067,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },
  "groq:meta-llama/llama-4-scout-17b-16e-instruct": {
    provider: "groq", model: "meta-llama/llama-4-scout-17b-16e-instruct",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.00011, costPer1kOutput: 0.00034,
    capabilities: ["text", "tools", "vision"],
    tier: "cheap",
  },

  // Alibaba Qwen on Groq
  "groq:qwen/qwen3-32b": {
    provider: "groq", model: "qwen/qwen3-32b",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.00029, costPer1kOutput: 0.00039,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },

  // OpenAI OSS on Groq
  "groq:openai/gpt-oss-120b": {
    provider: "groq", model: "openai/gpt-oss-120b",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.00015, costPer1kOutput: 0.0006,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },
  "groq:openai/gpt-oss-20b": {
    provider: "groq", model: "openai/gpt-oss-20b",
    contextWindow: 131_072, compactAt: 90_000,
    costPer1kInput: 0.000075, costPer1kOutput: 0.0003,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },

  // Moonshot Kimi on Groq
  "groq:moonshotai/kimi-k2-instruct-0905": {
    provider: "groq", model: "moonshotai/kimi-k2-instruct-0905",
    contextWindow: 262_144, compactAt: 180_000,
    costPer1kInput: 0.001, costPer1kOutput: 0.003,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },

  // ─── DeepSeek ──────────────────────────────────────────────────────────────

  "deepseek:deepseek-chat": {
    provider: "deepseek", model: "deepseek-chat",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.00028, costPer1kOutput: 0.00042,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },
  "deepseek:deepseek-reasoner": {
    provider: "deepseek", model: "deepseek-reasoner",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.0005, costPer1kOutput: 0.00218,
    capabilities: ["text", "tools", "reasoning"],
    tier: "cheap",
  },

  // ─── Mistral ───────────────────────────────────────────────────────────────

  "mistral:mistral-large-latest": {
    provider: "mistral", model: "mistral-large-latest",
    contextWindow: 262_000, compactAt: 180_000,
    costPer1kInput: 0.0005, costPer1kOutput: 0.0015,
    capabilities: ["text", "tools", "structured-output", "vision"],
    tier: "standard",
  },
  "mistral:mistral-medium-latest": {
    provider: "mistral", model: "mistral-medium-latest",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.0004, costPer1kOutput: 0.002,
    capabilities: ["text", "tools", "vision"],
    tier: "cheap",
  },
  "mistral:mistral-small-latest": {
    provider: "mistral", model: "mistral-small-latest",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.00006, costPer1kOutput: 0.00018,
    capabilities: ["text", "tools", "vision"],
    tier: "cheap",
  },
  "mistral:codestral-latest": {
    provider: "mistral", model: "codestral-latest",
    contextWindow: 256_000, compactAt: 180_000,
    costPer1kInput: 0.0002, costPer1kOutput: 0.0006,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },
  "mistral:devstral-2512": {
    provider: "mistral", model: "devstral-2512",
    contextWindow: 256_000, compactAt: 180_000,
    costPer1kInput: 0.0004, costPer1kOutput: 0.002,
    capabilities: ["text", "tools"],
    tier: "standard",
  },
  "mistral:devstral-small-2": {
    provider: "mistral", model: "devstral-small-2",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.0001, costPer1kOutput: 0.0003,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },

  // ─── OpenRouter (any model via openrouter.ai) ───────────────────────────────
  // OpenRouter proxies multiple providers. Model IDs use provider/model format.
  // Pricing varies per upstream model - these are representative defaults.
  // Any openrouter:* model not listed here works via dynamic passthrough.

  // Free tier models (no cost, rate-limited)
  "openrouter:stepfun/step-3.5-flash:free": {
    provider: "openrouter", model: "stepfun/step-3.5-flash:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:openrouter/free": {
    provider: "openrouter", model: "openrouter/free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:nousresearch/hermes-3-llama-3.1-405b:free": {
    provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-405b:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:qwen/qwen3-4b:free": {
    provider: "openrouter", model: "qwen/qwen3-4b:free",
    contextWindow: 32_000, compactAt: 22_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:openai/gpt-oss-20b:free": {
    provider: "openrouter", model: "openai/gpt-oss-20b:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:openai/gpt-oss-120b:free": {
    provider: "openrouter", model: "openai/gpt-oss-120b:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:qwen/qwen3-coder:free": {
    provider: "openrouter", model: "qwen/qwen3-coder:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "openrouter:z-ai/glm-4.5-air:free": {
    provider: "openrouter", model: "z-ai/glm-4.5-air:free",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0, costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },

  // Paid models
  "openrouter:anthropic/claude-opus-4-6": {
    provider: "openrouter", model: "anthropic/claude-opus-4-6",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.015, costPer1kOutput: 0.075,
    capabilities: ["text", "tools", "vision"],
    tier: "expensive",
  },
  "openrouter:anthropic/claude-sonnet-4-6": {
    provider: "openrouter", model: "anthropic/claude-sonnet-4-6",
    contextWindow: 200_000, compactAt: 140_000,
    costPer1kInput: 0.003, costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "vision"],
    tier: "standard",
  },
  "openrouter:openai/gpt-4o": {
    provider: "openrouter", model: "openai/gpt-4o",
    contextWindow: 128_000, compactAt: 90_000,
    costPer1kInput: 0.0025, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "vision"],
    tier: "standard",
  },
  "openrouter:google/gemini-2.5-pro": {
    provider: "openrouter", model: "google/gemini-2.5-pro",
    contextWindow: 1_000_000, compactAt: 700_000,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
    capabilities: ["text", "tools", "vision"],
    tier: "standard",
  },
  "openrouter:deepseek/deepseek-chat-v3": {
    provider: "openrouter", model: "deepseek/deepseek-chat-v3",
    contextWindow: 64_000, compactAt: 45_000,
    costPer1kInput: 0.00014, costPer1kOutput: 0.00028,
    capabilities: ["text", "tools"],
    tier: "cheap",
  },
  "openrouter:meta-llama/llama-4-scout": {
    provider: "openrouter", model: "meta-llama/llama-4-scout",
    contextWindow: 512_000, compactAt: 350_000,
    costPer1kInput: 0.00015, costPer1kOutput: 0.0006,
    capabilities: ["text", "tools", "vision"],
    tier: "cheap",
  },

  // Ollama models intentionally NOT hardcoded — they're discovered live
  // from `${OLLAMA_BASE_URL}/api/tags` in ModelRouter.listAvailableModels()
  // so users only see models they've actually pulled.
};

/**
 * Fallback chains - if preferred model fails, try next in chain.
 */
export const fallbackChains = {
  cheap: [
    "openai:gpt-5-mini", "openai:gpt-4.1-mini", "anthropic:claude-haiku-4-5",
    "google:gemini-2.5-flash", "google:gemini-2.0-flash", "deepseek:deepseek-chat",
    "mistral:mistral-small-latest", "xai:grok-4-1-fast-non-reasoning", "xai:grok-4-fast-non-reasoning", "ollama:llama3.1",
  ],
  standard: [
    "openai:gpt-5.2", "openai:gpt-4.1", "anthropic:claude-sonnet-4-6",
    "google:gemini-2.5-pro", "xai:grok-4-0709", "mistral:mistral-large-latest",
    "deepseek:deepseek-chat", "ollama:llama3.1",
  ],
  expensive: [
    "anthropic:claude-opus-4-6", "openai:gpt-5.4", "anthropic:claude-sonnet-4-6",
    "openai:o3-pro", "google:gemini-3.1-pro-preview", "xai:grok-4-0709",
  ],
  local: ["ollama:llama4:scout", "ollama:llama4:maverick", "ollama:llama3.1", "ollama:qwen2.5-coder", "ollama:llama3"],
};
