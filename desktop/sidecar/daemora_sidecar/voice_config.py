"""Voice pipeline configuration.

Source of truth for STT / TTS / voice settings is Daemora's own config —
the same fields visible in the Settings UI:

    STT_MODEL         →  e.g. "whisper-large-v3-turbo" / "whisper-1" / "nova-3"
    TTS_MODEL         →  e.g. "gpt-4o-mini-tts" / "eleven_turbo_v2_5"
    TTS_VOICE         →  provider-specific voice id
    TTS_GROQ_MODEL    →  legacy override

Daemora writes these into process.env after vault unlock. The sidecar
inherits them via the managed child-process spawn (Daemora supervisor).

Provider is INFERRED from the model name — the user doesn't have to
pick a provider explicitly. If STT_MODEL is empty we auto-detect
whichever key is present.

Override chain, highest precedence first:
  1. DAEMORA_STT_PROVIDER / DAEMORA_TTS_PROVIDER (explicit override)
  2. STT_MODEL / TTS_MODEL name → inferred provider
  3. First available provider key
"""

import os
from dataclasses import dataclass


_STT_MODEL_HINTS = {
    "whisper-large-v3-turbo": "groq",
    "whisper-large-v3": "groq",
    "whisper-1": "openai",
    "whisper-medium": "openai",
    "nova-3": "deepgram",
    "nova-2": "deepgram",
    "enhanced": "deepgram",
    "best": "assemblyai",
    "latest_long": "google",
    "latest_short": "google",
}

_TTS_MODEL_HINTS = {
    "gpt-4o-mini-tts": "openai",
    "gpt-4o-tts": "openai",
    "tts-1": "openai",
    "tts-1-hd": "openai",
    "eleven_turbo_v2_5": "elevenlabs",
    "eleven_multilingual_v2": "elevenlabs",
    "eleven_monolingual_v1": "elevenlabs",
    "sonic-english": "cartesia",
    "sonic-multilingual": "cartesia",
    "sonic": "cartesia",
    "neural2": "google",
    "kokoro": "local",
    "kokoro-82m": "local",
    "piper": "local",
}


def _infer_provider(model: str | None, hints: dict[str, str]) -> str | None:
    if not model:
        return None
    m = model.lower()
    if m in hints:
        return hints[m]
    for k, v in hints.items():
        if k in m:
            return v
    return None


def _pick_stt() -> tuple[str, str | None]:
    """(provider, model) resolved from Daemora config first, then env."""
    explicit = os.environ.get("DAEMORA_STT_PROVIDER")
    stt_model = os.environ.get("STT_MODEL") or None

    if explicit:
        return (explicit.lower(), stt_model)

    inferred = _infer_provider(stt_model, _STT_MODEL_HINTS)
    if inferred:
        return (inferred, stt_model)

    # Auto-detect from available keys, preferring speed
    if os.environ.get("GROQ_API_KEY"):       return ("groq", stt_model)
    if os.environ.get("DEEPGRAM_API_KEY"):   return ("deepgram", stt_model)
    if os.environ.get("OPENAI_API_KEY"):     return ("openai", stt_model)
    if os.environ.get("ASSEMBLYAI_API_KEY"): return ("assemblyai", stt_model)
    # No cloud key → fall back to local (faster-whisper). Works only if the
    # user installed offline extras: ./bootstrap.sh --local
    return ("local", stt_model)


def _pick_tts() -> tuple[str, str | None, str | None]:
    """(provider, model, voice) resolved from Daemora config first, then env."""
    explicit = os.environ.get("DAEMORA_TTS_PROVIDER")
    tts_model = os.environ.get("TTS_MODEL") or os.environ.get("TTS_MODEL_ELEVEN") or None
    tts_voice = os.environ.get("TTS_VOICE") or None

    if explicit:
        return (explicit.lower(), tts_model, tts_voice)

    inferred = _infer_provider(tts_model, _TTS_MODEL_HINTS)
    if inferred:
        return (inferred, tts_model, tts_voice)

    if os.environ.get("ELEVENLABS_API_KEY"): return ("elevenlabs", tts_model, tts_voice)
    if os.environ.get("CARTESIA_API_KEY"):   return ("cartesia", tts_model, tts_voice)
    if os.environ.get("OPENAI_API_KEY"):     return ("openai", tts_model, tts_voice)
    # No cloud key → fall back to local (Kokoro). Works only if the user
    # installed offline extras: ./bootstrap.sh --local
    return ("local", tts_model, tts_voice)


@dataclass
class VoiceConfig:
    # LiveKit local server (loopback SFU)
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    room_name: str

    # Provider selection + model, resolved from Daemora's config
    stt_provider: str
    stt_model: str | None
    tts_provider: str
    tts_model: str | None
    llm_provider: str

    # Voice identity
    tts_voice: str | None
    wake_word: str
    wake_word_enabled: bool

    # Daemora HTTP (for the custom LLM plugin)
    daemora_http: str
    daemora_auth_token: str | None

    # Language
    language: str


def load() -> VoiceConfig:
    stt_provider, stt_model = _pick_stt()
    tts_provider, tts_model, tts_voice = _pick_tts()
    return VoiceConfig(
        livekit_url=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"),
        livekit_api_key=os.environ.get("LIVEKIT_API_KEY", "devkey"),
        livekit_api_secret=os.environ.get("LIVEKIT_API_SECRET", "secret"),
        room_name=os.environ.get("DAEMORA_VOICE_ROOM", "daemora-local"),
        stt_provider=stt_provider,
        stt_model=stt_model,
        tts_provider=tts_provider,
        tts_model=tts_model,
        llm_provider="daemora",
        tts_voice=tts_voice,
        wake_word=os.environ.get("DAEMORA_WAKE_WORD", "hey_daemora"),
        wake_word_enabled=os.environ.get("DAEMORA_WAKE_WORD_ENABLED", "true").lower() in ("1", "true", "yes"),
        daemora_http=os.environ.get("DAEMORA_HTTP", "http://127.0.0.1:8081"),
        daemora_auth_token=os.environ.get("DAEMORA_AUTH_TOKEN") or None,
        language=os.environ.get("DAEMORA_VOICE_LANGUAGE", "en"),
    )
