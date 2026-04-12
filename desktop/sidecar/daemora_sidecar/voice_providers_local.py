"""Local STT / TTS wrappers — opt-in offline mode.

Default local models (2026 picks):
  STT — faster-whisper small.en (CTranslate2 port, Apache-2.0, ~240 MB)
  TTS — Kokoro-82M (hexgrad, Apache-2.0, ~330 MB, higher quality than Piper)

Installed only when the user picks "Offline mode" in the first-run wizard
or runs `./bootstrap.sh --local`. The provider factory in
voice_providers.py is string-dispatched — adding more local options
(Moonshine, Distil-Whisper, OuteTTS, Parler-TTS, XTTS-v2, etc.) is a
one-branch change.

Status: stubs. The base classes and capability shapes are correct but
the actual transcribe / synthesize paths aren't wired yet. Reason: cloud
providers (Groq STT, OpenAI TTS) fully cover testing today and we're
unblocked on the voice pipeline. Real offline mode ships as an explicit
user opt-in during Phase 5 (first-run wizard).

To finish the implementation later:
  1. FasterWhisperSTT._recognize_impl:
     - Convert AudioBuffer → numpy float32 @ 16 kHz
     - Call self._model.transcribe(audio, language=...)
     - Return SpeechEvent(FINAL_TRANSCRIPT, alternatives=[SpeechData(...)])
  2. KokoroTTS subclass of tts.TTS + KokoroChunkedStream subclass of
     tts.ChunkedStream:
     - KPipeline(lang_code='a')(text, voice='af_heart') yields
       (gs, ps, audio_float32) tuples
     - Convert audio_float32 → int16 PCM @ 24 kHz
     - Wrap each chunk in SynthesizedAudio(frame=AudioFrame(...))
     - Emit via self._event_ch.send_nowait(...)
"""

from __future__ import annotations

from livekit.agents import APIConnectOptions, stt, tts
from livekit.agents.types import NOT_GIVEN, NotGivenOr
from livekit.agents.utils import AudioBuffer


class LocalSTTNotReady(RuntimeError):
    pass


class LocalTTSNotReady(RuntimeError):
    pass


class FasterWhisperSTT(stt.STT):
    """Local Whisper inference via faster-whisper. Stub — see module docstring."""

    def __init__(self, model: str = "small.en", device: str = "auto"):
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=False, interim_results=False)
        )
        self._model_name = model
        self._device = device
        try:
            from faster_whisper import WhisperModel  # noqa: F401
        except ImportError as e:
            raise LocalSTTNotReady(
                "faster-whisper not installed. Reinstall with offline extras: "
                "cd desktop/sidecar && ./bootstrap.sh --local"
            ) from e

    @property
    def provider(self) -> str:
        return "faster-whisper"

    @property
    def model(self) -> str:
        return self._model_name

    async def _recognize_impl(
        self,
        buffer: AudioBuffer,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions,
    ) -> stt.SpeechEvent:
        raise NotImplementedError(
            "FasterWhisperSTT._recognize_impl is a stub. See voice_providers_local.py docstring "
            "for the implementation plan. For testing, use DAEMORA_STT_PROVIDER=groq (already "
            "~120 ms latency, free tier)."
        )


class KokoroTTS(tts.TTS):
    """Local TTS via hexgrad Kokoro-82M. Stub — see module docstring.

    Kokoro is ~82M params, Apache-2.0, runs on CPU, 24 kHz output,
    significantly better voice quality than Piper for a similar size.
    HF: https://huggingface.co/hexgrad/Kokoro-82M
    """

    def __init__(self, voice: str = "af_heart", lang_code: str = "a"):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._voice = voice
        self._lang_code = lang_code
        try:
            import kokoro  # noqa: F401
        except ImportError as e:
            raise LocalTTSNotReady(
                "kokoro not installed. Reinstall with offline extras: "
                "cd desktop/sidecar && ./bootstrap.sh --local"
            ) from e

    @property
    def provider(self) -> str:
        return "kokoro"

    @property
    def model(self) -> str:
        return f"kokoro-82m:{self._voice}"

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = APIConnectOptions(),
    ) -> tts.ChunkedStream:
        raise NotImplementedError(
            "KokoroTTS.synthesize is a stub. See voice_providers_local.py docstring "
            "for the implementation plan. For testing, use DAEMORA_TTS_PROVIDER=openai "
            "(gpt-4o-mini-tts, ~100 ms first-chunk, cheap)."
        )
