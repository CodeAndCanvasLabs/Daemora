import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock

from . import config


_lock = Lock()
_recent_actions: list[float] = []


class RateLimitError(Exception):
    pass


def check_rate_limit() -> None:
    now = time.time()
    with _lock:
        cutoff = now - 60
        while _recent_actions and _recent_actions[0] < cutoff:
            _recent_actions.pop(0)
        if len(_recent_actions) >= config.MAX_ACTIONS_PER_MINUTE:
            raise RateLimitError(
                f"Desktop action rate limit hit ({config.MAX_ACTIONS_PER_MINUTE}/min). "
                f"Wait before retrying."
            )
        _recent_actions.append(now)


def record(action: str, params: dict, screenshot_path: str | None = None) -> None:
    entry = {
        "ts": datetime.utcnow().isoformat() + "Z",
        "action": action,
        "params": params,
        "screenshot": screenshot_path,
    }
    day = datetime.utcnow().strftime("%Y-%m-%d")
    log_file = config.AUDIT_DIR / f"{day}.jsonl"
    with log_file.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def prune_old() -> int:
    cutoff = datetime.utcnow() - timedelta(days=config.AUDIT_RETENTION_DAYS)
    removed = 0
    for p in config.AUDIT_DIR.glob("*.jsonl"):
        try:
            day = datetime.strptime(p.stem, "%Y-%m-%d")
            if day < cutoff:
                p.unlink()
                removed += 1
        except ValueError:
            continue
    for p in config.SCREENSHOT_DIR.glob("*.png"):
        if datetime.fromtimestamp(p.stat().st_mtime) < cutoff:
            p.unlink()
            removed += 1
    return removed
