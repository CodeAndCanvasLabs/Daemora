/**
 * Model registry types.
 *
 * A model is identified as `provider:model` (e.g. "anthropic:claude-sonnet-4-6"),
 * matching Daemora's existing convention so users don't relearn anything.
 */

import type { LanguageModel } from "ai";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "vertex"
  | "vertex-anthropic"
  | "groq"
  | "nvidia"
  | "ollama";

export interface ProviderInfo {
  readonly id: ProviderId;
  /** Vault key holding the API key. `null` for keyless providers (Ollama). */
  readonly apiKeyEnv: string | null;
  /** Optional base URL override (for OpenAI-compat endpoints, custom Ollama hosts). */
  readonly baseUrlEnv?: string;
  /** Default base URL when the env var isn't set. */
  readonly defaultBaseUrl?: string;
}

export interface ResolvedModel {
  readonly id: string;          // "anthropic:claude-sonnet-4-6"
  readonly provider: ProviderId;
  readonly modelName: string;   // "claude-sonnet-4-6"
  readonly model: LanguageModel;
}
