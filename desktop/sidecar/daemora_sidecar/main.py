"""Daemora desktop sidecar — HTTP server exposing desktop control and (later) voice pipeline."""

from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import audit, config, desktop

app = FastAPI(title="Daemora Sidecar", version="0.1.0")


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
