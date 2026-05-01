/**
 * Provider catalog — the single source of truth for ALL providers
 * (LLM, STT, TTS, search). Each entry declares:
 *   - what secret it needs
 *   - what models it offers (static list + optional dynamic discovery)
 *   - its capabilities (llm, stt, tts, search, embeddings)
 *   - whether it's currently configured (derived at runtime from vault)
 *
 * The /api/providers endpoint serialises this catalog so the UI can
 * render provider cards, model selectors, and voice config without
 * any client-side guesswork.
 */

export type ProviderCapability = "llm" | "stt" | "tts" | "search" | "embeddings" | "image" | "video";

export interface ModelDef {
  readonly id: string;          // e.g. "claude-sonnet-4-20250514"
  readonly name: string;        // human label
  readonly tier: "frontier" | "fast" | "reasoning" | "local" | "embed";
  readonly contextWindow?: number;
}

export interface VoiceDef {
  readonly id: string;
  readonly name: string;
}

export interface ProviderDef {
  readonly id: string;
  readonly name: string;
  readonly secretKey: string | null;    // vault key needed, null = keyless
  readonly capabilities: readonly ProviderCapability[];
  /** Static model catalog. Providers with dynamic discovery still list
   *  their headline models here for instant UI rendering — the dynamic
   *  endpoint enriches later. */
  readonly models: readonly ModelDef[];
  /** STT models if this provider does speech-to-text. */
  readonly sttModels?: readonly ModelDef[];
  /** TTS models/voices if this provider does text-to-speech. */
  readonly ttsModels?: readonly ModelDef[];
  readonly ttsVoices?: readonly VoiceDef[];
  /** Image generation models if the provider supports text-to-image. */
  readonly imageModels?: readonly ModelDef[];
  /** Video generation models if the provider supports text-to-video. */
  readonly videoModels?: readonly ModelDef[];
  /** If true, /api/providers/:id/models will call the provider's API
   *  to discover models dynamically (OpenAI, Ollama, Groq). */
  readonly dynamicModelDiscovery?: boolean;
  /** Base URL config key if customisable (Ollama, Groq). */
  readonly baseUrlSetting?: string;
  readonly defaultBaseUrl?: string;
  /** Recommended default model when user first configures this provider. */
  readonly defaultModel?: string;
  /** Recommended default STT model. Derived from sttModels[0] if not set. */
  readonly defaultSttModel?: string;
  /** Recommended default TTS model. Derived from ttsModels[0] if not set. */
  readonly defaultTtsModel?: string;
  /** Recommended default TTS voice. Derived from ttsVoices[0] if not set. */
  readonly defaultTtsVoice?: string;
  /** Recommended default image-gen model. Derived from imageModels[0] if not set. */
  readonly defaultImageModel?: string;
  /** Recommended default video-gen model. Derived from videoModels[0] if not set. */
  readonly defaultVideoModel?: string;
}

export const PROVIDER_CATALOG: readonly ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    secretKey: "ANTHROPIC_API_KEY",
    capabilities: ["llm"],
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", tier: "frontier", contextWindow: 1_000_000 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", tier: "frontier", contextWindow: 1_000_000 },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-opus-4", name: "Claude Opus 4", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tier: "fast", contextWindow: 200_000 },
      { id: "claude-haiku-3-5", name: "Claude Haiku 3.5", tier: "fast", contextWindow: 200_000 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    secretKey: "OPENAI_API_KEY",
    capabilities: ["llm", "stt", "tts", "embeddings", "image", "video"],
    dynamicModelDiscovery: true,
    defaultModel: "gpt-5.4",
    defaultImageModel: "dall-e-3",
    defaultVideoModel: "sora",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", tier: "frontier", contextWindow: 1_000_000 },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", tier: "fast", contextWindow: 1_000_000 },
      { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", tier: "frontier", contextWindow: 1_000_000 },
      { id: "gpt-5.2", name: "GPT-5.2", tier: "frontier", contextWindow: 400_000 },
      { id: "gpt-5.2-pro", name: "GPT-5.2 Pro", tier: "frontier", contextWindow: 400_000 },
      { id: "gpt-5.1", name: "GPT-5.1", tier: "frontier", contextWindow: 400_000 },
      { id: "gpt-5", name: "GPT-5", tier: "frontier", contextWindow: 400_000 },
      { id: "gpt-5-mini", name: "GPT-5 Mini", tier: "fast", contextWindow: 400_000 },
      { id: "gpt-5-nano", name: "GPT-5 Nano", tier: "fast", contextWindow: 400_000 },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", tier: "frontier", contextWindow: 400_000 },
      { id: "gpt-4.1", name: "GPT-4.1", tier: "frontier", contextWindow: 1_000_000 },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", tier: "fast", contextWindow: 1_000_000 },
      { id: "gpt-4o", name: "GPT-4o", tier: "frontier", contextWindow: 128_000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", tier: "fast", contextWindow: 128_000 },
      { id: "o3-pro", name: "o3 Pro", tier: "reasoning", contextWindow: 200_000 },
      { id: "o3", name: "o3", tier: "reasoning", contextWindow: 200_000 },
      { id: "o4-mini", name: "o4-mini", tier: "reasoning", contextWindow: 200_000 },
      { id: "o3-mini", name: "o3-mini", tier: "reasoning", contextWindow: 200_000 },
    ],
    sttModels: [
      { id: "whisper-1", name: "Whisper", tier: "frontier" },
    ],
    ttsModels: [
      { id: "tts-1", name: "TTS-1", tier: "fast" },
      { id: "tts-1-hd", name: "TTS-1 HD", tier: "frontier" },
    ],
    ttsVoices: [
      { id: "nova", name: "Nova" }, { id: "alloy", name: "Alloy" },
      { id: "echo", name: "Echo" }, { id: "fable", name: "Fable" },
      { id: "onyx", name: "Onyx" }, { id: "shimmer", name: "Shimmer" },
      { id: "ash", name: "Ash" }, { id: "coral", name: "Coral" },
      { id: "sage", name: "Sage" },
    ],
    imageModels: [
      { id: "gpt-image-1", name: "GPT Image 1", tier: "frontier" },
      { id: "dall-e-3", name: "DALL-E 3", tier: "frontier" },
      { id: "dall-e-2", name: "DALL-E 2", tier: "fast" },
    ],
    videoModels: [
      { id: "sora", name: "Sora", tier: "frontier" },
    ],
  },
  {
    id: "google",
    name: "Google AI",
    secretKey: "GOOGLE_AI_API_KEY",
    capabilities: ["llm", "embeddings", "image", "video"],
    defaultModel: "gemini-2.5-flash",
    defaultImageModel: "gemini-2.5-flash-image",
    defaultVideoModel: "veo-3.1-fast-generate-001",
    dynamicModelDiscovery: true,
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", tier: "frontier", contextWindow: 2_000_000 },
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-3-pro-preview", name: "Gemini 3 Pro", tier: "frontier", contextWindow: 2_000_000 },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "frontier", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", tier: "fast", contextWindow: 1_000_000 },
    ],
    imageModels: [
      // "Nano Banana Pro" — Gemini 3 Pro Image, top quality
      { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana Pro)", tier: "frontier" },
      // "Nano Banana" — Gemini 2.5 Flash Image, fast + cheap, conversational editing
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image (Nano Banana)", tier: "fast" },
    ],
    // Veo on Gemini Developer API — exact model id strings per
    // https://ai.google.dev/gemini-api/docs/video. Preview variants use the
    // `-preview` suffix; stable variants use `-001`. Vertex naming differs.
    videoModels: [
      { id: "veo-3.1-generate-preview", name: "Veo 3.1 (Preview)", tier: "frontier" },
      { id: "veo-3.1-fast-generate-preview", name: "Veo 3.1 Fast (Preview)", tier: "fast" },
      { id: "veo-3.1-lite-generate-preview", name: "Veo 3.1 Lite (Preview)", tier: "fast" },
      { id: "veo-3.0-generate-001", name: "Veo 3", tier: "frontier" },
      { id: "veo-3.0-fast-generate-001", name: "Veo 3 Fast", tier: "fast" },
      { id: "veo-2.0-generate-001", name: "Veo 2", tier: "fast" },
    ],
  },
  {
    // Vertex AI Express — same Gemini model line as Google AI but
    // billed through GCP. API-key auth only (no service-account / no
    // project / no location needed). Static seed below is fallback —
    // discovery hits publishers/google/models for the live list.
    // Source: docs.cloud.google.com/vertex-ai/generative-ai/docs/models
    id: "vertex",
    name: "Vertex AI (Express)",
    secretKey: "GOOGLE_VERTEX_API_KEY",
    // Image gen via Gemini-on-Vertex works with Express keys; Imagen +
    // Veo support attempted via Vertex Express endpoint with API-key auth
    // — may 401 in some regions; tool falls through to GOOGLE_AI_API_KEY
    // (Gemini Developer API) if the Vertex call fails.
    capabilities: ["llm", "image", "video"],
    defaultModel: "gemini-3.1-pro-preview",
    defaultImageModel: "gemini-2.5-flash-image",
    defaultVideoModel: "veo-3.1-fast-generate-001",
    dynamicModelDiscovery: true,
    models: [
      // Preview models pinned to the `global` endpoint — accessible to
      // any project with Vertex AI enabled (PUBLIC_PREVIEW launchStage).
      // Daemora routes Gemini-on-Vertex through SA + global to reach
      // them; Express API keys only see GA models.
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", tier: "frontier", contextWindow: 2_000_000 },
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite (Preview)", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash Image (Preview)", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (Preview)", tier: "frontier", contextWindow: 2_000_000 },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (Preview)", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "frontier", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", tier: "fast", contextWindow: 1_000_000 },
      { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", tier: "fast", contextWindow: 1_000_000 },
    ],
    imageModels: [
      { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana Pro)", tier: "frontier" },
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image (Nano Banana)", tier: "fast" },
    ],
    videoModels: [
      { id: "veo-3.1-fast-generate-001", name: "Veo 3.1 Fast", tier: "fast" },
      { id: "veo-3.1-generate-001", name: "Veo 3.1", tier: "frontier" },
      { id: "veo-3.0-generate-001", name: "Veo 3", tier: "frontier" },
      { id: "veo-2.0-generate-001", name: "Veo 2", tier: "fast" },
    ],
  },
  {
    // Claude on Vertex — partner model line, billed against your GCP
    // project (so eats $300 free credit, not Anthropic balance). Auth
    // is Service Account JSON only — Express API keys cover Gemini
    // alone. SA file path lives in ModelRouter.ts (TEMP).
    id: "vertex-anthropic",
    name: "Anthropic on Vertex (SA)",
    secretKey: null,
    capabilities: ["llm"],
    defaultModel: "claude-sonnet-4-6",
    // Source: @ai-sdk/google-vertex/dist/anthropic/*.d.ts
    // (GoogleVertexAnthropicMessagesModelId). The 4.6/4.7 generation
    // dropped the @date suffix; older snapshots keep it. Don't add ids
    // not in that union — they 404 on Vertex.
    models: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7 (Vertex)", tier: "frontier", contextWindow: 1_000_000 },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Vertex)", tier: "frontier", contextWindow: 1_000_000 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Vertex)", tier: "frontier", contextWindow: 1_000_000 },
      { id: "claude-opus-4-5@20251101", name: "Claude Opus 4.5 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-sonnet-4-5@20250929", name: "Claude Sonnet 4.5 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-opus-4-1@20250805", name: "Claude Opus 4.1 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-opus-4@20250514", name: "Claude Opus 4 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-sonnet-4@20250514", name: "Claude Sonnet 4 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-3-7-sonnet@20250219", name: "Claude 3.7 Sonnet (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-3-5-sonnet-v2@20241022", name: "Claude 3.5 Sonnet v2 (Vertex)", tier: "frontier", contextWindow: 200_000 },
      { id: "claude-3-5-haiku@20241022", name: "Claude 3.5 Haiku (Vertex)", tier: "fast", contextWindow: 200_000 },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    secretKey: "GROQ_API_KEY",
    capabilities: ["llm", "stt", "tts"],
    dynamicModelDiscovery: true,
    baseUrlSetting: "GROQ_BASE_URL",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", tier: "fast", contextWindow: 128_000 },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", tier: "fast", contextWindow: 128_000 },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", tier: "fast", contextWindow: 128_000 },
      { id: "qwen/qwen3-32b", name: "Qwen 3 32B", tier: "fast", contextWindow: 128_000 },
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", tier: "fast", contextWindow: 128_000 },
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", tier: "fast", contextWindow: 128_000 },
      { id: "moonshotai/kimi-k2-instruct-0905", name: "Kimi K2", tier: "fast", contextWindow: 128_000 },
    ],
    sttModels: [
      { id: "whisper-large-v3-turbo", name: "Whisper v3 Turbo", tier: "fast" },
    ],
    ttsModels: [
      { id: "canopylabs/orpheus-v1-english", name: "Orpheus v1 English", tier: "fast" },
      { id: "canopylabs/orpheus-arabic-saudi", name: "Orpheus Arabic (Saudi)", tier: "fast" },
    ],
    ttsVoices: [
      { id: "troy", name: "Troy" }, { id: "hannah", name: "Hannah" },
      { id: "austin", name: "Austin" }, { id: "diana", name: "Diana" },
      { id: "autumn", name: "Autumn" }, { id: "daniel", name: "Daniel" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    secretKey: "NVIDIA_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "deepseek-ai/deepseek-v3.2",
    // Static seed: real model IDs from /v1/models — used as fallback if
    // discovery fails. Discovery returns 140+ models; the filter in
    // discovery.ts narrows to chat/instruct families.
    models: [
      { id: "deepseek-ai/deepseek-v3.2", name: "DeepSeek v3.2", tier: "frontier", contextWindow: 128_000 },
      { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek v4 Pro", tier: "frontier", contextWindow: 128_000 },
      { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct", tier: "fast", contextWindow: 128_000 },
      { id: "meta/llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick 17B", tier: "frontier", contextWindow: 1_000_000 },
      { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", name: "Nemotron Super 49B", tier: "frontier", contextWindow: 128_000 },
      { id: "qwen/qwen3-next-80b-a3b-instruct", name: "Qwen 3 Next 80B", tier: "frontier", contextWindow: 128_000 },
      { id: "mistralai/mistral-large-2-instruct", name: "Mistral Large 2", tier: "frontier", contextWindow: 128_000 },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    secretKey: null,
    capabilities: ["llm", "embeddings"],
    dynamicModelDiscovery: true,
    baseUrlSetting: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://localhost:11434",
    models: [], // entirely dynamic — populated from /api/tags
  },
  {
    id: "deepgram",
    name: "Deepgram",
    secretKey: "DEEPGRAM_API_KEY",
    capabilities: ["stt"],
    models: [],
    sttModels: [
      { id: "nova-2", name: "Nova-2 (Streaming)", tier: "frontier" },
    ],
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    secretKey: "ASSEMBLYAI_API_KEY",
    capabilities: ["stt"],
    models: [],
    sttModels: [
      { id: "best", name: "Best (Universal-2)", tier: "frontier" },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    secretKey: "ELEVENLABS_API_KEY",
    // Scribe handles STT (batch); /v1/models endpoint handles TTS.
    // Separate underlying endpoints, same API key.
    capabilities: ["stt", "tts"],
    models: [],
    sttModels: [
      { id: "scribe_v2", name: "Scribe v2", tier: "frontier" },
      { id: "scribe_v1", name: "Scribe v1", tier: "fast" },
    ],
    ttsModels: [
      { id: "eleven_multilingual_v2", name: "Multilingual v2", tier: "frontier" },
      { id: "eleven_turbo_v2_5", name: "Turbo v2.5", tier: "fast" },
    ],
  },
  {
    id: "cartesia",
    name: "Cartesia",
    secretKey: "CARTESIA_API_KEY",
    capabilities: ["tts"],
    models: [],
    ttsModels: [
      { id: "sonic-2", name: "Sonic 2", tier: "fast" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    secretKey: "OPENROUTER_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    models: [
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (OR)", tier: "frontier", contextWindow: 200_000 },
      { id: "openai/gpt-4o", name: "GPT-4o (OR)", tier: "frontier", contextWindow: 128_000 },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (OR)", tier: "fast", contextWindow: 1_000_000 },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B (OR)", tier: "fast", contextWindow: 128_000 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    secretKey: "DEEPSEEK_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", tier: "frontier", contextWindow: 128_000 },
      { id: "deepseek-reasoner", name: "DeepSeek R1", tier: "reasoning", contextWindow: 128_000 },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    secretKey: "MISTRAL_API_KEY",
    capabilities: ["llm", "embeddings"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", tier: "frontier", contextWindow: 128_000 },
      { id: "mistral-medium-latest", name: "Mistral Medium", tier: "frontier", contextWindow: 128_000 },
      { id: "mistral-small-latest", name: "Mistral Small", tier: "fast", contextWindow: 128_000 },
      { id: "codestral-latest", name: "Codestral", tier: "frontier", contextWindow: 256_000 },
      { id: "devstral-2512", name: "Devstral", tier: "frontier", contextWindow: 256_000 },
      { id: "devstral-small-2", name: "Devstral Small", tier: "fast", contextWindow: 128_000 },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    secretKey: "XAI_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4-fast-non-reasoning",
    models: [
      { id: "grok-4.20-multi-agent-beta-0309", name: "Grok 4.20 Multi-Agent", tier: "frontier", contextWindow: 256_000 },
      { id: "grok-4.20-beta-0309-reasoning", name: "Grok 4.20 Reasoning", tier: "reasoning", contextWindow: 256_000 },
      { id: "grok-4.20-beta-0309-non-reasoning", name: "Grok 4.20", tier: "frontier", contextWindow: 256_000 },
      { id: "grok-code-fast-1", name: "Grok Code Fast", tier: "fast", contextWindow: 256_000 },
      { id: "grok-4-fast-reasoning", name: "Grok 4 Fast Reasoning", tier: "reasoning", contextWindow: 256_000 },
      { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast", tier: "fast", contextWindow: 256_000 },
      { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast Reasoning", tier: "reasoning", contextWindow: 256_000 },
      { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast", tier: "fast", contextWindow: 256_000 },
      { id: "grok-4-0709", name: "Grok 4", tier: "frontier", contextWindow: 256_000 },
      { id: "grok-3", name: "Grok 3", tier: "frontier", contextWindow: 131_072 },
      { id: "grok-3-mini", name: "Grok 3 Mini", tier: "fast", contextWindow: 131_072 },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    secretKey: "TOGETHER_API_KEY",
    capabilities: ["llm", "embeddings"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.together.xyz/v1",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo", tier: "fast", contextWindow: 128_000 },
      { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", name: "Qwen 2.5 72B Turbo", tier: "fast", contextWindow: 128_000 },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    secretKey: "FIREWORKS_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    models: [
      { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", name: "Llama 3.3 70B", tier: "fast" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    secretKey: "CEREBRAS_API_KEY",
    capabilities: ["llm"],
    dynamicModelDiscovery: true,
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B (Cerebras)", tier: "fast" },
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    secretKey: "PERPLEXITY_API_KEY",
    capabilities: ["llm"],
    // No model listing API — static only
    models: [
      { id: "sonar-pro", name: "Sonar Pro", tier: "frontier", contextWindow: 200_000 },
      { id: "sonar", name: "Sonar", tier: "fast", contextWindow: 128_000 },
      { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", tier: "reasoning", contextWindow: 128_000 },
    ],
  },
  {
    id: "brave",
    name: "Brave Search",
    secretKey: "BRAVE_SEARCH_API_KEY",
    capabilities: ["search"],
    models: [],
  },
];

/** Lookup by id. */
export const PROVIDERS_BY_ID = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));

/**
 * Resolve the recommended default model / voice for each capability.
 * Order: explicit `defaultXxx` field on the provider, then fall back to
 * the first entry in the corresponding catalog list. Returns `undefined`
 * when the provider has no entries at all (e.g. cartesia doesn't ship a
 * voice catalog yet — caller must surface that gap).
 *
 * IMPORTANT: these helpers ONLY return values that already exist in the
 * `PROVIDER_CATALOG` data above — they do not invent or hardcode model
 * ids from outside this file. Adding new defaults means editing the
 * catalog entry above.
 */
export function defaultModelFor(p: ProviderDef): string | undefined {
  return p.defaultModel ?? p.models[0]?.id;
}
export function defaultSttModelFor(p: ProviderDef): string | undefined {
  return p.defaultSttModel ?? p.sttModels?.[0]?.id;
}
export function defaultTtsModelFor(p: ProviderDef): string | undefined {
  return p.defaultTtsModel ?? p.ttsModels?.[0]?.id;
}
export function defaultTtsVoiceFor(p: ProviderDef): string | undefined {
  return p.defaultTtsVoice ?? p.ttsVoices?.[0]?.id;
}
export function defaultImageModelFor(p: ProviderDef): string | undefined {
  return p.defaultImageModel ?? p.imageModels?.[0]?.id;
}
export function defaultVideoModelFor(p: ProviderDef): string | undefined {
  return p.defaultVideoModel ?? p.videoModels?.[0]?.id;
}
