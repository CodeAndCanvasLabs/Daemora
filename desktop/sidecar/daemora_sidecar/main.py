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
    if not config.SIDECAR_TOKEN:
        return
    if x_daemora_token != config.SIDECAR_TOKEN:
        raise HTTPException(status_code=401, detail="invalid sidecar token")


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
