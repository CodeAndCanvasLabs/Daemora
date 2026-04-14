"""Wake word listener — always-on background mic scanning for the user's
configured wake phrase.

Uses OpenWakeWord (MIT-licensed, ~5MB pre-trained models) for low-CPU
always-listening detection. Runs in a separate thread so the FastAPI
server isn't blocked. On detection, posts to the local voice endpoint
to start the full LiveKit pipeline.

Pre-trained models available (downloaded on first start):
  - hey_daemora (custom — uses hey_jarvis as fallback since no official)
  - hey_jarvis
  - hey_mycroft
  - hey_rhasspy
  - alexa

Default is "hey_jarvis" since it's the most reliable pre-trained model.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Optional

log = logging.getLogger("daemora.wake_word")

# Maps user-friendly names to OpenWakeWord model identifiers
WAKE_MODELS = {
    "hey_jarvis": "hey_jarvis_v0.1",
    "hey_mycroft": "hey_mycroft_v0.1",
    "hey_rhasspy": "hey_rhasspy_v0.1",
    "alexa": "alexa_v0.1",
}

# "hey_daemora" falls back to hey_jarvis (closest in sound) until we train a custom model
DEFAULT_WAKE_MODEL = "hey_jarvis_v0.1"


class WakeWordListener:
    def __init__(self, on_wake):
        self._on_wake = on_wake
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._running = False
        self._last_detection = 0.0

    def start(self, wake_word: str = "hey_jarvis", threshold: float = 0.5):
        if self._running:
            return
        self._stop.clear()
        self._running = True
        self._thread = threading.Thread(
            target=self._run,
            args=(wake_word, threshold),
            daemon=True,
            name="wake-word-listener",
        )
        self._thread.start()
        log.info("wake word listener started (word=%s, threshold=%s)", wake_word, threshold)

    def stop(self):
        if not self._running:
            return
        self._stop.set()
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
        log.info("wake word listener stopped")

    @property
    def running(self) -> bool:
        return self._running

    def _run(self, wake_word: str, threshold: float):
        import time
        try:
            import numpy as np
            import sounddevice as sd
            from openwakeword.model import Model
        except Exception as e:
            log.error("wake word deps missing: %s", e)
            self._running = False
            return

        # Map friendly name to model file
        model_name = WAKE_MODELS.get(wake_word.lower().replace(" ", "_"), DEFAULT_WAKE_MODEL)

        try:
            # inference_framework="onnx" is the default and most portable
            model = Model(
                wakeword_models=[model_name],
                inference_framework="onnx",
            )
        except Exception as e:
            log.error("failed to load wake word model %s: %s", model_name, e)
            self._running = False
            return

        log.info("wake word model loaded: %s", model_name)

        # OpenWakeWord expects 16kHz mono int16
        SAMPLE_RATE = 16000
        CHUNK = 1280  # 80ms chunks (standard for openwakeword)

        # Cooldown between detections to prevent double-fire
        COOLDOWN_S = 3.0

        def audio_callback(indata, frames, time_info, status):
            if status:
                log.debug("sounddevice status: %s", status)

        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=CHUNK,
                callback=audio_callback,
            ) as stream:
                while not self._stop.is_set():
                    try:
                        audio, _ = stream.read(CHUNK)
                        audio_int16 = audio.flatten().astype(np.int16)

                        # Run inference
                        scores = model.predict(audio_int16)

                        # Check if any loaded model triggered
                        for mdl_name, score in scores.items():
                            if score >= threshold:
                                now = time.time()
                                if now - self._last_detection > COOLDOWN_S:
                                    self._last_detection = now
                                    log.info("WAKE: %s (score=%.2f)", mdl_name, score)
                                    try:
                                        self._on_wake(mdl_name, score)
                                    except Exception as e:
                                        log.error("on_wake callback failed: %s", e)
                    except Exception as e:
                        log.error("wake word loop error: %s", e)
                        time.sleep(0.1)
        except Exception as e:
            log.error("wake word stream failed: %s", e)
        finally:
            self._running = False
            log.info("wake word listener exited")


# Singleton for the sidecar
_listener: Optional[WakeWordListener] = None


def get_listener() -> WakeWordListener:
    global _listener
    if _listener is None:
        _listener = WakeWordListener(on_wake=_default_on_wake)
    return _listener


def _default_on_wake(model_name: str, score: float):
    """Default handler — post to the voice endpoint to start the full pipeline."""
    import httpx

    sidecar_port = os.environ.get("DAEMORA_SIDECAR_PORT", "8765")
    sidecar_token = os.environ.get("DAEMORA_SIDECAR_TOKEN", "")

    url = f"http://127.0.0.1:{sidecar_port}/voice/wake-trigger"
    try:
        httpx.post(
            url,
            headers={"X-Daemora-Token": sidecar_token},
            json={"model": model_name, "score": score},
            timeout=3.0,
        )
    except Exception as e:
        log.error("failed to trigger wake: %s", e)
