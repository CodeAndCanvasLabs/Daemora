import os
from pathlib import Path

HOME = Path(os.environ.get("DAEMORA_HOME", Path.home() / ".daemora"))
SIDECAR_PORT = int(os.environ.get("DAEMORA_SIDECAR_PORT", "8765"))
SIDECAR_TOKEN = os.environ.get("DAEMORA_SIDECAR_TOKEN", "")
DAEMORA_HTTP = os.environ.get("DAEMORA_HTTP", "http://127.0.0.1:8081")

AUDIT_DIR = HOME / "desktop-audit"
SCREENSHOT_DIR = HOME / "screenshots"
for _d in (AUDIT_DIR, SCREENSHOT_DIR):
    _d.mkdir(parents=True, exist_ok=True)

MAX_ACTIONS_PER_MINUTE = int(os.environ.get("DAEMORA_DESKTOP_RATE_LIMIT", "20"))
AUDIT_RETENTION_DAYS = int(os.environ.get("DAEMORA_AUDIT_RETENTION", "7"))

BLOCKED_WINDOW_KEYWORDS = [
    s.strip().lower()
    for s in os.environ.get(
        "DAEMORA_DESKTOP_BLOCKED_WINDOWS",
        "keychain,1password,bitwarden,lastpass,system settings,system preferences,control panel",
    ).split(",")
    if s.strip()
]
