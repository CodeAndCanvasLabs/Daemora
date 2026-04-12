"""STT / TTS / VAD provider factory.

Returns LiveKit Agents plugin instances built from the VoiceConfig. Each
factory does a lazy import so missing optional providers don't crash the
whole pipeline — only the one the user picked has to be installed.
"""

from __future__ import annotations

import os
from typing import Any

from .voice_config import VoiceConfig


class ProviderError(RuntimeError):
    pass


def _require(env: str, provider: str) -> str:
    v = os.environ.get(env)
    if not v:
        raise ProviderError(
            f"{provider} selected but {env} not set. Open the Daemora settings "
            f"and add the key, or pick a different provider."
        )
    return v


# ── STT ────────────────────────────────────────────────────────────────────

def build_stt(cfg: VoiceConfig) -> Any:
    p = cfg.stt_provider
    if p == "deepgram":
        from livekit.plugins import deepgram
        return deepgram.STT(
            api_key=_require("DEEPGRAM_API_KEY", "Deepgram"),
            model="nova-3",
            language=cfg.language,
            smart_format=True,
            interim_results=True,
        )
    if p == "groq":
        from livekit.plugins import groq
        return groq.STT(
            api_key=_require("GROQ_API_KEY", "Groq Whisper"),
            model="whisper-large-v3-turbo",
            language=cfg.language,
        )
    if p == "openai":
        from livekit.plugins import openai
        return openai.STT(
            api_key=_require("OPENAI_API_KEY", "OpenAI Whisper"),
            model="whisper-1",
            language=cfg.language,
        )
    if p == "google":
        from livekit.plugins import google
        return google.STT(
            credentials_file=_require("GOOGLE_APPLICATION_CREDENTIALS", "Google Speech"),
            languages=[cfg.language],
        )
    if p == "assemblyai":
        from livekit.plugins import assemblyai
        return assemblyai.STT(
            api_key=_require("ASSEMBLYAI_API_KEY", "AssemblyAI"),
        )
    raise ProviderError(f"Unknown STT provider: {p!r}")


# ── TTS ────────────────────────────────────────────────────────────────────

def build_tts(cfg: VoiceConfig) -> Any:
    p = cfg.tts_provider
    if p == "elevenlabs":
        from livekit.plugins import elevenlabs
        return elevenlabs.TTS(
            api_key=_require("ELEVENLABS_API_KEY", "ElevenLabs"),
            voice_id=cfg.tts_voice or "cgSgspJ2msm6clMCkdW9",  # Jessica, matches Daemora default
            model="eleven_turbo_v2_5",
        )
    if p == "cartesia":
        from livekit.plugins import cartesia
        return cartesia.TTS(
            api_key=_require("CARTESIA_API_KEY", "Cartesia"),
            voice=cfg.tts_voice or "a0e99841-438c-4a64-b679-ae501e7d6091",
            model="sonic-english",
        )
    if p == "openai":
        from livekit.plugins import openai
        return openai.TTS(
            api_key=_require("OPENAI_API_KEY", "OpenAI TTS"),
            voice=cfg.tts_voice or "nova",
            model="gpt-4o-mini-tts",
        )
    if p == "google":
        from livekit.plugins import google
        return google.TTS(
            credentials_file=_require("GOOGLE_APPLICATION_CREDENTIALS", "Google TTS"),
            language=cfg.language,
            voice_name=cfg.tts_voice or "en-US-Neural2-F",
        )
    raise ProviderError(f"Unknown TTS provider: {p!r}")


# ── VAD (always local) ─────────────────────────────────────────────────────

def build_vad() -> Any:
    from livekit.plugins import silero
    return silero.VAD.load(
        min_speech_duration=0.1,
        min_silence_duration=0.5,
    )
