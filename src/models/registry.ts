/**
 * Provider registry — single source of truth for which providers exist
 * and which vault secret each one needs.
 *
 * The actual SDK adapter is loaded LAZILY (dynamic import) the first
 * time a provider is needed. Keeps startup fast and lets the package
 * tree stay slim if a provider isn't used.
 */

import type { ProviderId, ProviderInfo } from "./types.js";

export const providerRegistry: Readonly<Record<ProviderId, ProviderInfo>> = {
  anthropic: { id: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai:    { id: "openai",    apiKeyEnv: "OPENAI_API_KEY" },
  google:    { id: "google",    apiKeyEnv: "GOOGLE_AI_API_KEY" },
  vertex:    { id: "vertex",    apiKeyEnv: "GOOGLE_VERTEX_API_KEY" },
  // Claude on Vertex — auth via Service Account JSON, not vault. The
  // hardcoded SA constants live in src/models/ModelRouter.ts (mirrors
  // generateVideo.ts) for the $300 free-credit window. apiKeyEnv: null
  // means providerAvailable() returns true unconditionally — gated by
  // the SA file existing on disk, checked at resolve() time.
  "vertex-anthropic": { id: "vertex-anthropic", apiKeyEnv: null },
  groq: {
    id: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    baseUrlEnv: "GROQ_BASE_URL",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  nvidia: {
    id: "nvidia",
    apiKeyEnv: "NVIDIA_API_KEY",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  },
  ollama: {
    id: "ollama",
    apiKeyEnv: null,
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://localhost:11434",
  },
};

export const providerIds: readonly ProviderId[] = Object.keys(providerRegistry) as ProviderId[];

export function isKnownProvider(id: string): id is ProviderId {
  return id in providerRegistry;
}
