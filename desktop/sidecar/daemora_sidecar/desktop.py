"""PyAutoGUI wrapper with safety rails. All desktop control goes through here."""

import os
import platform
import time
from datetime import datetime
from pathlib import Path

from . import audit, config

# Configure PyAutoGUI fail-safe before importing anything else
os.environ.setdefault("PYAUTOGUI_FAILSAFE", "1")
import pyautogui  # noqa: E402

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05


class BlockedWindowError(Exception):
    pass


def _check_active_window() -> None:
    """Refuse to act if the frontmost window is in the block list."""
    try:
        title = _get_active_window_title() or ""
    except Exception:
        return
    lower = title.lower()
    for keyword in config.BLOCKED_WINDOW_KEYWORDS:
        if keyword and keyword in lower:
            raise BlockedWindowError(
                f"Active window '{title}' matches blocked keyword '{keyword}'. "
                f"Desktop actions refused for safety."
            )


def _get_active_window_title() -> str | None:
    system = platform.system()
    if system == "Darwin":
        try:
            from AppKit import NSWorkspace  # type: ignore

            ws = NSWorkspace.sharedWorkspace()
            app = ws.frontmostApplication()
            return app.localizedName() if app else None
        except Exception:
            return None
    if system == "Windows":
        try:
            import pygetwindow  # type: ignore

            w = pygetwindow.getActiveWindow()
            return w.title if w else None
        except Exception:
            return None
    return None


def _snapshot(action: str) -> str:
    """Grab a screenshot for the audit log. Returns absolute path."""
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
    path = config.SCREENSHOT_DIR / f"{action}-{ts}.png"
    try:
        img = pyautogui.screenshot()
        img.save(str(path))
    except Exception:
        return ""
    return str(path)


def _gate(action: str, params: dict) -> str:
    audit.check_rate_limit()
    _check_active_window()
    shot = _snapshot(action)
    audit.record(action, params, shot)
    return shot


def mouse_click(x: int, y: int, button: str = "left", clicks: int = 1) -> dict:
    _gate("mouse_click", {"x": x, "y": y, "button": button, "clicks": clicks})
    pyautogui.click(x=x, y=y, button=button, clicks=clicks)
    return {"ok": True}


def mouse_move(x: int, y: int, duration: float = 0.0) -> dict:
    _gate("mouse_move", {"x": x, "y": y, "duration": duration})
    pyautogui.moveTo(x, y, duration=duration)
    return {"ok": True}


def type_text(text: str, interval: float = 0.01) -> dict:
    _gate("type_text", {"length": len(text), "interval": interval})
    pyautogui.write(text, interval=interval)
    return {"ok": True, "chars": len(text)}


def press_key(key: str) -> dict:
    _gate("press_key", {"key": key})
    pyautogui.press(key)
    return {"ok": True}


def key_combo(keys: list[str]) -> dict:
    _gate("key_combo", {"keys": keys})
    pyautogui.hotkey(*keys)
    return {"ok": True}


def scroll(dx: int, dy: int) -> dict:
    _gate("scroll", {"dx": dx, "dy": dy})
    if dy:
        pyautogui.scroll(dy)
    if dx:
        pyautogui.hscroll(dx)
    return {"ok": True}


def screenshot(region: dict | None = None) -> dict:
    audit.check_rate_limit()
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
    path = config.SCREENSHOT_DIR / f"manual-{ts}.png"
    if region:
        img = pyautogui.screenshot(
            region=(region["x"], region["y"], region["width"], region["height"])
        )
    else:
        img = pyautogui.screenshot()
    img.save(str(path))
    audit.record("screenshot", region or {}, str(path))
    w, h = img.size
    return {"ok": True, "path": str(path), "width": w, "height": h}


def screen_size() -> dict:
    w, h = pyautogui.size()
    return {"width": int(w), "height": int(h)}


def list_windows() -> dict:
    """Return a best-effort list of visible windows. Platform specific."""
    system = platform.system()
    windows: list[dict] = []
    if system == "Darwin":
        try:
            from AppKit import NSWorkspace  # type: ignore

            ws = NSWorkspace.sharedWorkspace()
            for app in ws.runningApplications():
                if app.activationPolicy() == 0:  # Regular GUI app
                    windows.append(
                        {
                            "title": app.localizedName() or "",
                            "pid": int(app.processIdentifier()),
                            "active": bool(app.isActive()),
                        }
                    )
        except Exception as e:
            return {"ok": False, "error": str(e), "windows": []}
    elif system == "Windows":
        try:
            import pygetwindow  # type: ignore

            for w in pygetwindow.getAllWindows():
                if w.title:
                    windows.append({"title": w.title, "active": w.isActive})
        except Exception as e:
            return {"ok": False, "error": str(e), "windows": []}
    else:
        # Linux — best-effort via wmctrl if available, else empty
        try:
            import subprocess

            out = subprocess.check_output(["wmctrl", "-l"], text=True, timeout=2)
            for line in out.splitlines():
                parts = line.split(None, 3)
                if len(parts) == 4:
                    windows.append({"title": parts[3]})
        except Exception:
            pass
    return {"ok": True, "windows": windows}


def focus_window(name: str) -> dict:
    _gate("focus_window", {"name": name})
    system = platform.system()
    if system == "Darwin":
        try:
            import subprocess

            subprocess.run(
                ["osascript", "-e", f'tell application "{name}" to activate'],
                check=True,
                timeout=3,
            )
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if system == "Windows":
        try:
            import pygetwindow  # type: ignore

            matches = [w for w in pygetwindow.getAllWindows() if name.lower() in w.title.lower()]
            if not matches:
                return {"ok": False, "error": f"No window matching '{name}'"}
            matches[0].activate()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": "focusWindow not supported on this platform"}
