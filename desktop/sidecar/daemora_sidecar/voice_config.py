"""Voice pipeline configuration.

Reads from env vars (which the Tauri shell / first-run wizard writes via
Daemora's vault → process.env, passed through when spawning the sidecar).

Provider-pluggable: swap STT/TTS/LLM by env alone, no code change.
"""

import os
from dataclasses import dataclass


@dataclass
class VoiceConfig:
    # LiveKit local server (loopback SFU)
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    room_name: str

    # Provider selection — each stage picks one plugin
    stt_provider: str        # deepgram | openai | groq | google | assemblyai
    tts_provider: str        # elevenlabs | cartesia | openai | google
    llm_provider: str        # always "daemora" (we stream from /api/chat SSE)

    # Voice identity
    tts_voice: str | None    # provider-specific voice ID
    wake_word: str           # default "hey_daemora"
    wake_word_enabled: bool

    # Daemora HTTP (for the custom LLM plugin)
    daemora_http: str
    daemora_auth_token: str | None

    # Language
    language: str


def load() -> VoiceConfig:
    return VoiceConfig(
        livekit_url=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"),
        livekit_api_key=os.environ.get("LIVEKIT_API_KEY", "devkey"),
        livekit_api_secret=os.environ.get("LIVEKIT_API_SECRET", "secret"),
        room_name=os.environ.get("DAEMORA_VOICE_ROOM", "daemora-local"),
        stt_provider=os.environ.get("DAEMORA_STT_PROVIDER", "deepgram").lower(),
        tts_provider=os.environ.get("DAEMORA_TTS_PROVIDER", "elevenlabs").lower(),
        llm_provider="daemora",
        tts_voice=os.environ.get("DAEMORA_TTS_VOICE") or None,
        wake_word=os.environ.get("DAEMORA_WAKE_WORD", "hey_daemora"),
        wake_word_enabled=os.environ.get("DAEMORA_WAKE_WORD_ENABLED", "true").lower() in ("1", "true", "yes"),
        daemora_http=os.environ.get("DAEMORA_HTTP", "http://127.0.0.1:8081"),
        daemora_auth_token=os.environ.get("DAEMORA_AUTH_TOKEN") or None,
        language=os.environ.get("DAEMORA_VOICE_LANGUAGE", "en"),
    )
