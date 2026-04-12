"""Daemora desktop sidecar — HTTP server exposing desktop control and voice pipeline."""

import asyncio
import logging
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import audit, config, desktop

log = logging.getLogger("daemora.sidecar")

app = FastAPI(title="Daemora Sidecar", version="0.2.0")

# Voice agent state (lazy-imported — voice deps are optional)
_voice_task: Optional[asyncio.Task] = None
_voice_error: Optional[str] = None


def verify_token(x_daemora_token: Optional[str] = Header(default=None)) -> None:
    # Token is MANDATORY — no unauthenticated path. The sidecar refuses to
    # start if DAEMORA_SIDECAR_TOKEN is unset (see module-init check below).
    if x_daemora_token != config.SIDECAR_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing sidecar token")


if not config.SIDECAR_TOKEN:
    raise RuntimeError(
        "DAEMORA_SIDECAR_TOKEN not set. The sidecar must be spawned by Daemora "
        "(which generates a random token per spawn) or launched with the token "
        "explicitly set in env. Refusing to start unauthenticated."
    )


def handle(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except audit.RateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except desktop.BlockedWindowError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": "0.1.0", "screen": desktop.screen_size()}


class ClickReq(BaseModel):
    x: int
    y: int
    button: str = Field("left", pattern="^(left|right|middle)$")
    clicks: int = Field(1, ge=1, le=3)


@app.post("/desktop/click", dependencies=[Depends(verify_token)])
def http_click(req: ClickReq) -> dict:
    return handle(desktop.mouse_click, req.x, req.y, req.button, req.clicks)


class MoveReq(BaseModel):
    x: int
    y: int
    duration: float = 0.0


@app.post("/desktop/move", dependencies=[Depends(verify_token)])
def http_move(req: MoveReq) -> dict:
    return handle(desktop.mouse_move, req.x, req.y, req.duration)


class TypeReq(BaseModel):
    text: str
    interval: float = 0.01


@app.post("/desktop/type", dependencies=[Depends(verify_token)])
def http_type(req: TypeReq) -> dict:
    return handle(desktop.type_text, req.text, req.interval)


class KeyReq(BaseModel):
    key: str


@app.post("/desktop/keypress", dependencies=[Depends(verify_token)])
def http_key(req: KeyReq) -> dict:
    return handle(desktop.press_key, req.key)


class ComboReq(BaseModel):
    keys: list[str]


@app.post("/desktop/combo", dependencies=[Depends(verify_token)])
def http_combo(req: ComboReq) -> dict:
    return handle(desktop.key_combo, req.keys)


class ScrollReq(BaseModel):
    dx: int = 0
    dy: int = 0


@app.post("/desktop/scroll", dependencies=[Depends(verify_token)])
def http_scroll(req: ScrollReq) -> dict:
    return handle(desktop.scroll, req.dx, req.dy)


class ScreenshotReq(BaseModel):
    region: Optional[dict] = None


@app.post("/desktop/screenshot", dependencies=[Depends(verify_token)])
def http_screenshot(req: ScreenshotReq) -> dict:
    return handle(desktop.screenshot, req.region)


@app.get("/desktop/windows", dependencies=[Depends(verify_token)])
def http_list_windows() -> dict:
    return handle(desktop.list_windows)


class FocusReq(BaseModel):
    name: str


@app.post("/desktop/focus", dependencies=[Depends(verify_token)])
def http_focus(req: FocusReq) -> dict:
    return handle(desktop.focus_window, req.name)


@app.post("/desktop/audit/prune", dependencies=[Depends(verify_token)])
def http_prune() -> dict:
    return {"ok": True, "removed": audit.prune_old()}


# ── Voice pipeline endpoints ──────────────────────────────────────────────

@app.get("/voice/status", dependencies=[Depends(verify_token)])
def voice_status() -> dict:
    running = _voice_task is not None and not _voice_task.done()
    return {
        "running": running,
        "error": _voice_error,
    }


def _detect_providers() -> tuple[str, str]:
    """Auto-pick STT/TTS providers from whichever keys Daemora passed down."""
    import os as _os

    stt = _os.environ.get("DAEMORA_STT_PROVIDER")
    if not stt:
        if _os.environ.get("GROQ_API_KEY"): stt = "groq"
        elif _os.environ.get("DEEPGRAM_API_KEY"): stt = "deepgram"
        elif _os.environ.get("OPENAI_API_KEY"): stt = "openai"
        elif _os.environ.get("ASSEMBLYAI_API_KEY"): stt = "assemblyai"
        else: stt = "groq"  # default target; will fail fast with a clear error

    tts = _os.environ.get("DAEMORA_TTS_PROVIDER")
    if not tts:
        if _os.environ.get("ELEVENLABS_API_KEY"): tts = "elevenlabs"
        elif _os.environ.get("CARTESIA_API_KEY"): tts = "cartesia"
        elif _os.environ.get("OPENAI_API_KEY"): tts = "openai"
        else: tts = "openai"

    _os.environ["DAEMORA_STT_PROVIDER"] = stt
    _os.environ["DAEMORA_TTS_PROVIDER"] = tts
    return stt, tts


@app.post("/voice/start", dependencies=[Depends(verify_token)])
async def voice_start() -> dict:
    global _voice_task, _voice_error
    if _voice_task is not None and not _voice_task.done():
        return {"ok": True, "already_running": True}

    try:
        from . import voice_agent, voice_config
    except Exception as e:
        _voice_error = f"voice extras not installed: {e}"
        raise HTTPException(status_code=503, detail=_voice_error)

    stt, tts = _detect_providers()
    cfg = voice_config.load()
    log.info("starting voice agent (stt=%s tts=%s)", cfg.stt_provider, cfg.tts_provider)

    async def _run():
        try:
            await voice_agent.entrypoint_standalone()
        except Exception as e:
            log.exception("voice agent crashed")
            global _voice_error
            _voice_error = str(e)

    _voice_error = None
    _voice_task = asyncio.create_task(_run())
    return {"ok": True, "stt": cfg.stt_provider, "tts": cfg.tts_provider}


@app.post("/voice/stop", dependencies=[Depends(verify_token)])
async def voice_stop() -> dict:
    global _voice_task
    if _voice_task is None or _voice_task.done():
        return {"ok": True, "running": False}
    _voice_task.cancel()
    try:
        await _voice_task
    except (asyncio.CancelledError, Exception):
        pass
    _voice_task = None
    return {"ok": True, "running": False}


# ── Wake word endpoints ────────────────────────────────────────────────────

class WakeStartReq(BaseModel):
    wake_word: str = Field(default="hey_jarvis", description="Wake word name")
    threshold: float = Field(default=0.5, description="Detection threshold 0-1")


@app.post("/wake/start", dependencies=[Depends(verify_token)])
def wake_start(req: WakeStartReq) -> dict:
    from . import wake_word
    listener = wake_word.get_listener()
    if listener.running:
        return {"ok": True, "already_running": True}
    try:
        listener.start(wake_word=req.wake_word, threshold=req.threshold)
        return {"ok": True, "wake_word": req.wake_word, "threshold": req.threshold}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/wake/stop", dependencies=[Depends(verify_token)])
def wake_stop() -> dict:
    from . import wake_word
    listener = wake_word.get_listener()
    listener.stop()
    return {"ok": True, "running": False}


@app.get("/wake/status", dependencies=[Depends(verify_token)])
def wake_status() -> dict:
    from . import wake_word
    listener = wake_word.get_listener()
    return {"running": listener.running}


@app.post("/voice/wake-trigger", dependencies=[Depends(verify_token)])
async def voice_wake_trigger(req: dict) -> dict:
    """Called by the wake word listener when a wake phrase is detected.
    Starts the full LiveKit voice session."""
    global _voice_task
    if _voice_task is not None and not _voice_task.done():
        return {"ok": True, "already_running": True}

    # Notify Daemora via HTTP so the UI can react (show active voice orb)
    try:
        import httpx
        import os as _os
        daemora_http = _os.environ.get("DAEMORA_HTTP", "http://127.0.0.1:8081")
        daemora_token = _os.environ.get("DAEMORA_AUTH_TOKEN", "")
        await httpx.AsyncClient(timeout=2.0).post(
            f"{daemora_http}/api/voice/wake-event",
            headers={"Authorization": f"Bearer {daemora_token}"},
            json={"model": req.get("model"), "score": req.get("score", 0)},
        )
    except Exception as e:
        log.warning("failed to notify daemora of wake: %s", e)

    # Start voice agent
    try:
        from . import voice_agent
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"voice extras not installed: {e}")

    _detect_providers()

    async def _run():
        try:
            await voice_agent.entrypoint_standalone()
        except Exception as e:
            log.exception("voice agent crashed after wake")
            global _voice_error
            _voice_error = str(e)

    _voice_error = None
    _voice_task = asyncio.create_task(_run())
    return {"ok": True, "wake_triggered": True}


def run() -> None:
    import uvicorn

    uvicorn.run(
        "daemora_sidecar.main:app",
        host="127.0.0.1",
        port=config.SIDECAR_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    run()
