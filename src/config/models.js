/**
 * Model registry - metadata for all supported models.
 * Used by ModelRouter for selection, cost tracking, and compaction thresholds.
 */
export const models = {
  // OpenAI
  "openai:gpt-4.1-mini": {
    provider: "openai",
    model: "gpt-4.1-mini",
    contextWindow: 128_000,
    compactAt: 90_000,
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },
  "openai:gpt-4.1": {
    provider: "openai",
    model: "gpt-4.1",
    contextWindow: 128_000,
    compactAt: 90_000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "openai:o3-mini": {
    provider: "openai",
    model: "o3-mini",
    contextWindow: 200_000,
    compactAt: 140_000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    capabilities: ["text", "tools", "reasoning"],
    tier: "standard",
  },

  // Anthropic
  "anthropic:claude-sonnet-4-6": {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
    compactAt: 140_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    capabilities: ["text", "tools", "structured-output"],
    tier: "standard",
  },
  "anthropic:claude-opus-4-6": {
    provider: "anthropic",
    model: "claude-opus-4-6",
    contextWindow: 200_000,
    compactAt: 140_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ["text", "tools", "structured-output"],
    tier: "expensive",
  },
  "anthropic:claude-haiku-4-5": {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    contextWindow: 200_000,
    compactAt: 140_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // Google
  "google:gemini-2.0-flash": {
    provider: "google",
    model: "gemini-2.0-flash",
    contextWindow: 1_000_000,
    compactAt: 700_000,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    capabilities: ["text", "tools", "structured-output"],
    tier: "cheap",
  },

  // Ollama (local - no cost)
  "ollama:llama3": {
    provider: "ollama",
    model: "llama3",
    contextWindow: 8_192,
    compactAt: 5_600,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ["text"],
    tier: "free",
  },
  "ollama:llama3.1": {
    provider: "ollama",
    model: "llama3.1",
    contextWindow: 128_000,
    compactAt: 90_000,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
  "ollama:qwen2.5-coder": {
    provider: "ollama",
    model: "qwen2.5-coder",
    contextWindow: 32_000,
    compactAt: 22_000,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ["text", "tools"],
    tier: "free",
  },
};

/**
 * Fallback chains - if preferred model fails, try next in chain.
 */
export const fallbackChains = {
  cheap: ["openai:gpt-4.1-mini", "anthropic:claude-haiku-4-5", "google:gemini-2.0-flash"],
  standard: ["openai:gpt-4.1", "anthropic:claude-sonnet-4-6", "openai:gpt-4.1-mini"],
  expensive: ["anthropic:claude-opus-4-6", "anthropic:claude-sonnet-4-6", "openai:gpt-4.1"],
  local: ["ollama:llama3.1", "ollama:qwen2.5-coder", "ollama:llama3"],
};
