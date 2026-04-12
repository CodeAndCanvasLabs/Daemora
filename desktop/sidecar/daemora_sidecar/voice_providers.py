"""STT / TTS / VAD provider factory.

Returns LiveKit Agents plugin instances built from the VoiceConfig. Each
factory does a lazy import so missing optional providers don't crash the
whole pipeline — only the one the user picked has to be installed.

Model names are NOT hardcoded — every provider reads its model/voice
from env vars with a sensible 2026 default. Override per-provider with:
  DAEMORA_GROQ_STT_MODEL, DAEMORA_DEEPGRAM_STT_MODEL, DAEMORA_OPENAI_STT_MODEL,
  DAEMORA_ELEVENLABS_TTS_MODEL, DAEMORA_ELEVENLABS_TTS_VOICE,
  DAEMORA_CARTESIA_TTS_MODEL, DAEMORA_CARTESIA_TTS_VOICE,
  DAEMORA_OPENAI_TTS_MODEL, DAEMORA_OPENAI_TTS_VOICE,
  DAEMORA_GOOGLE_TTS_VOICE, ...

Fallback chain: build_stt / build_tts try the selected provider first,
then walk an ordered fallback list (Groq → Deepgram → OpenAI → ... for
STT; ElevenLabs → Cartesia → OpenAI → ... for TTS) and pick the first
one whose key is available. So if a user deletes a key, voice keeps
working on the next available provider instead of hard-failing.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable

from .voice_config import VoiceConfig

log = logging.getLogger("daemora.voice.providers")


class ProviderError(RuntimeError):
    pass


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


def _require(env: str, provider: str) -> str:
    v = os.environ.get(env)
    if not v:
        raise ProviderError(
            f"{provider} selected but {env} not set. Open the Daemora settings "
            f"and add the key, or pick a different provider."
        )
    return v


# ── STT builders ───────────────────────────────────────────────────────────

def _stt_local(cfg: VoiceConfig):
    from .voice_providers_local import FasterWhisperSTT
    return FasterWhisperSTT(model=_env("DAEMORA_LOCAL_WHISPER_MODEL", "small.en"))


def _stt_groq(cfg: VoiceConfig):
    from livekit.plugins import groq
    return groq.STT(
        api_key=_require("GROQ_API_KEY", "Groq Whisper"),
        model=_env("DAEMORA_GROQ_STT_MODEL", "whisper-large-v3-turbo"),
        language=cfg.language,
    )


def _stt_deepgram(cfg: VoiceConfig):
    from livekit.plugins import deepgram
    return deepgram.STT(
        api_key=_require("DEEPGRAM_API_KEY", "Deepgram"),
        model=_env("DAEMORA_DEEPGRAM_STT_MODEL", "nova-3"),
        language=cfg.language,
        smart_format=True,
        interim_results=True,
    )


def _stt_openai(cfg: VoiceConfig):
    from livekit.plugins import openai
    return openai.STT(
        api_key=_require("OPENAI_API_KEY", "OpenAI Whisper"),
        model=_env("DAEMORA_OPENAI_STT_MODEL", "whisper-1"),
        language=cfg.language,
    )


def _stt_google(cfg: VoiceConfig):
    from livekit.plugins import google
    return google.STT(
        credentials_file=_require("GOOGLE_APPLICATION_CREDENTIALS", "Google Speech"),
        languages=[cfg.language],
    )


def _stt_assemblyai(cfg: VoiceConfig):
    from livekit.plugins import assemblyai
    return assemblyai.STT(
        api_key=_require("ASSEMBLYAI_API_KEY", "AssemblyAI"),
    )


_STT_REGISTRY: dict[str, Callable[[VoiceConfig], Any]] = {
    "local": _stt_local,
    "faster-whisper": _stt_local,
    "groq": _stt_groq,
    "deepgram": _stt_deepgram,
    "openai": _stt_openai,
    "google": _stt_google,
    "assemblyai": _stt_assemblyai,
}

# Preferred fallback order — tried in sequence if the selected provider fails.
# Local is last because it requires extras to be installed.
_STT_FALLBACK_ORDER = ["groq", "deepgram", "openai", "assemblyai", "google", "local"]


def build_stt(cfg: VoiceConfig) -> Any:
    chain = _build_chain(cfg.stt_provider, _STT_FALLBACK_ORDER)
    return _try_chain("STT", chain, _STT_REGISTRY, cfg)


# ── TTS builders ───────────────────────────────────────────────────────────

def _tts_local(cfg: VoiceConfig):
    from .voice_providers_local import KokoroTTS
    return KokoroTTS(
        voice=_env("DAEMORA_LOCAL_KOKORO_VOICE", "af_heart"),
        lang_code=_env("DAEMORA_LOCAL_KOKORO_LANG", "a"),
    )


def _tts_elevenlabs(cfg: VoiceConfig):
    from livekit.plugins import elevenlabs
    return elevenlabs.TTS(
        api_key=_require("ELEVENLABS_API_KEY", "ElevenLabs"),
        voice_id=cfg.tts_voice or _env("DAEMORA_ELEVENLABS_TTS_VOICE", "cgSgspJ2msm6clMCkdW9"),
        model=_env("DAEMORA_ELEVENLABS_TTS_MODEL", "eleven_turbo_v2_5"),
    )


def _tts_cartesia(cfg: VoiceConfig):
    from livekit.plugins import cartesia
    return cartesia.TTS(
        api_key=_require("CARTESIA_API_KEY", "Cartesia"),
        voice=cfg.tts_voice or _env("DAEMORA_CARTESIA_TTS_VOICE", "a0e99841-438c-4a64-b679-ae501e7d6091"),
        model=_env("DAEMORA_CARTESIA_TTS_MODEL", "sonic-english"),
    )


def _tts_openai(cfg: VoiceConfig):
    from livekit.plugins import openai
    return openai.TTS(
        api_key=_require("OPENAI_API_KEY", "OpenAI TTS"),
        voice=cfg.tts_voice or _env("DAEMORA_OPENAI_TTS_VOICE", "nova"),
        model=_env("DAEMORA_OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
    )


def _tts_google(cfg: VoiceConfig):
    from livekit.plugins import google
    return google.TTS(
        credentials_file=_require("GOOGLE_APPLICATION_CREDENTIALS", "Google TTS"),
        language=cfg.language,
        voice_name=cfg.tts_voice or _env("DAEMORA_GOOGLE_TTS_VOICE", "en-US-Neural2-F"),
    )


def _tts_groq(cfg: VoiceConfig):
    from livekit.plugins import openai
    return openai.TTS(
        api_key=_require("GROQ_API_KEY", "Groq Orpheus TTS"),
        base_url="https://api.groq.com/openai/v1",
        voice=cfg.tts_voice or _env("DAEMORA_GROQ_TTS_VOICE", "troy"),
        model=_env("DAEMORA_GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english"),
    )


_TTS_REGISTRY: dict[str, Callable[[VoiceConfig], Any]] = {
    "local": _tts_local,
    "kokoro": _tts_local,
    "groq": _tts_groq,
    "elevenlabs": _tts_elevenlabs,
    "cartesia": _tts_cartesia,
    "openai": _tts_openai,
    "google": _tts_google,
}

_TTS_FALLBACK_ORDER = ["groq", "elevenlabs", "cartesia", "openai", "google", "local"]


def build_tts(cfg: VoiceConfig) -> Any:
    chain = _build_chain(cfg.tts_provider, _TTS_FALLBACK_ORDER)
    return _try_chain("TTS", chain, _TTS_REGISTRY, cfg)


# ── Fallback machinery ─────────────────────────────────────────────────────

def _build_chain(primary: str, order: list[str]) -> list[str]:
    """Return the selected provider first, then the fallback order with
    duplicates removed."""
    chain: list[str] = []
    if primary:
        chain.append(primary)
    for p in order:
        if p not in chain:
            chain.append(p)
    return chain


def _try_chain(kind: str, chain: list[str], registry: dict, cfg: VoiceConfig):
    errors: list[str] = []
    for name in chain:
        builder = registry.get(name)
        if not builder:
            errors.append(f"{name}: unknown")
            continue
        try:
            inst = builder(cfg)
            if name != chain[0]:
                log.warning("%s: primary provider %r failed, using fallback %r",
                            kind, chain[0], name)
            return inst
        except ProviderError as e:
            errors.append(f"{name}: {e}")
            continue
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}: {e}")
            continue
    raise ProviderError(
        f"No {kind} provider available. Tried: " + " | ".join(errors)
    )


# ── VAD (always local) ─────────────────────────────────────────────────────

def build_vad() -> Any:
    from livekit.plugins import silero
    return silero.VAD.load(
        min_speech_duration=0.5,
        min_silence_duration=1.5,
        activation_threshold=0.6,
    )
